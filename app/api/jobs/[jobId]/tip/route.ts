import { NextResponse } from "next/server";
import { z } from "zod";
import { randomUUID } from "crypto";
import { stripe } from "@/lib/stripe";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { ensureStripeCustomer } from "@/lib/ensure-stripe-customer";
import { computeJobTipSplit } from "@/lib/tip-split";

/**
 * Creates a tip for a completed, paid-for moving job. Charges
 * immediately (capture_method defaults to automatic — unlike the main
 * job payment, a tip has no "final amount" ambiguity to hold an
 * authorization open for) and returns a clientSecret for the frontend
 * to confirm via Stripe Elements. The actual TipAllocation rows (the
 * per-worker split) are only created once the webhook confirms the
 * charge succeeded — see app/api/stripe/webhook/route.ts.
 */
const schema = z.object({ amountCents: z.number().int().min(100).max(500_00) });

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["CUSTOMER", "ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { jobId } = await context.params;

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const job = await prisma.job.findUnique({ where: { id: jobId }, include: { customer: true } });
  if (!job) return NextResponse.json({ error: "Job not found." }, { status: 404 });
  if (authed.role === "CUSTOMER" && job.customer.userId !== authed.userId) {
    return NextResponse.json({ error: "Not your job." }, { status: 403 });
  }

  // Validate eligibility and the split up front — before charging the
  // customer — so a customer never gets charged for a tip that turns
  // out to have nowhere valid to go. The split itself is recomputed
  // (and is what actually matters) again once the payment succeeds.
  const split = await computeJobTipSplit(prisma, jobId, parsed.data.amountCents);
  if (!split.ok) return NextResponse.json({ error: split.reason }, { status: 409 });

  const stripeCustomerId = await ensureStripeCustomer(prisma, job.customerId);
  const idempotencyKey = `tip:${randomUUID()}`;

  const tip = await prisma.tip.create({
    data: {
      jobId, customerId: job.customerId, amountCents: parsed.data.amountCents,
      idempotencyKey, status: "PROCESSING",
    },
  });

  let intent;
  try {
    intent = await stripe.paymentIntents.create(
      {
        amount: parsed.data.amountCents,
        currency: "usd",
        customer: stripeCustomerId,
        automatic_payment_methods: { enabled: true },
        metadata: { type: "TIP", tipId: tip.id, jobId },
      },
      { idempotencyKey },
    );
  } catch (e) {
    await prisma.tip.update({ where: { id: tip.id }, data: { status: "FAILED", failureReason: e instanceof Error ? e.message : "Stripe error." } });
    return NextResponse.json({ error: "Failed to create tip payment." }, { status: 502 });
  }

  await prisma.tip.update({ where: { id: tip.id }, data: { stripePaymentIntentId: intent.id } });

  return NextResponse.json({ tipId: tip.id, clientSecret: intent.client_secret });
}
