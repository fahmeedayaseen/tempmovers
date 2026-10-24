import { NextResponse } from "next/server";
import { z } from "zod";
import { randomUUID } from "crypto";
import { stripe } from "@/lib/stripe";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { ensureStripeCustomer } from "@/lib/ensure-stripe-customer";
import { computeLoadTipRecipient } from "@/lib/tip-split";

/**
 * Freight equivalent of app/api/jobs/[jobId]/tip — same shape, same
 * immediate-charge approach, same webhook-driven allocation creation.
 * The customer here is the load's poster (postedByUserId), matching
 * the same ownership pattern used by driver-payment-intent and the
 * detention-charge route for the same load.
 */
const schema = z.object({ amountCents: z.number().int().min(100).max(500_00) });

export async function POST(request: Request, context: { params: Promise<{ loadId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["CUSTOMER", "ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { loadId } = await context.params;

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const load = await prisma.carrierRoute.findUnique({ where: { id: loadId } });
  if (!load) return NextResponse.json({ error: "Load not found." }, { status: 404 });
  if (authed.role === "CUSTOMER" && load.postedByUserId !== authed.userId) {
    return NextResponse.json({ error: "Not your load." }, { status: 403 });
  }

  const recipient = await computeLoadTipRecipient(prisma, loadId);
  if (!recipient.ok) return NextResponse.json({ error: recipient.reason }, { status: 409 });

  const customerProfile = await prisma.customerProfile.findUnique({ where: { userId: load.postedByUserId ?? undefined } });
  if (!customerProfile) return NextResponse.json({ error: "No customer profile on file for the load poster." }, { status: 409 });
  const stripeCustomerId = await ensureStripeCustomer(prisma, customerProfile.id);
  const idempotencyKey = `tip:${randomUUID()}`;

  const tip = await prisma.tip.create({
    data: {
      loadId, customerId: customerProfile.id, amountCents: parsed.data.amountCents,
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
        metadata: { type: "TIP", tipId: tip.id, loadId },
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
