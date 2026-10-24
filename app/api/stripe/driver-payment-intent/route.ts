import { NextResponse } from "next/server";
import { z } from "zod";
import { stripe, mapStripeIntentStatus } from "@/lib/stripe";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { claimNextPaymentAttempt, markAttemptCreated, markAttemptFailed } from "@/lib/payment-attempts";
import { ensureStripeCustomer } from "@/lib/ensure-stripe-customer";
import { accessorialSumsForLoad } from "@/lib/accessorials/sums";

/**
 * Server-authoritative: the PaymentIntent amount is built entirely from
 * the already-posted load record, never from client-submitted values.
 * Also verifies the authenticated customer actually posted this load.
 *
 * Same atomic-claim idempotency fix as job-payment-intent — see
 * lib/payment-attempts.ts.
 */
const schema = z.object({ jobId: z.string() });

export async function POST(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["CUSTOMER", "ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const load = await prisma.carrierRoute.findUnique({ where: { id: parsed.data.jobId } });
  if (!load) return NextResponse.json({ error: "Load not found." }, { status: 404 });

  if (authed.role !== "ADMIN" && load.postedByUserId !== authed.userId) {
    return NextResponse.json({ error: "You did not post this load." }, { status: 403 });
  }

  if (load.stripePaymentIntentId && load.paymentStatus !== "FAILED" && load.paymentStatus !== "CANCELED") {
    return NextResponse.json({ error: "Existing authorization must be updated or cancelled first." }, { status: 409 });
  }

  const posterUserId = authed.role === "ADMIN" ? load.postedByUserId ?? authed.userId : authed.userId;
  const customerProfile = await prisma.customerProfile.findUnique({ where: { userId: posterUserId } });
  if (!customerProfile) {
    return NextResponse.json({ error: "No customer profile on file for the load poster." }, { status: 409 });
  }
  const stripeCustomerId = await ensureStripeCustomer(prisma, customerProfile.id);

  // Step 6: include APPROVED accessorial customer charges in what the customer
  // authorizes. providerShare/platformShare of these are realized on the
  // settlement side (accessorialSumsForLoad), so the money reconciles.
  const accessorials = await accessorialSumsForLoad(load.id);
  const totalCents = load.grossCarrierCents + load.platformFeeCents + (load.accessorialsCents || 0) + accessorials.customerChargeCents;

  const attempt = await claimNextPaymentAttempt({ loadId: load.id }, "load-payment-intent");

  let intent;
  try {
    intent = await stripe.paymentIntents.create(
      {
        amount: totalCents,
        currency: "usd",
        customer: stripeCustomerId,
        capture_method: "manual",
        automatic_payment_methods: { enabled: true },
        metadata: {
          jobId: load.id, attemptNumber: String(attempt.attemptNumber), vehicleType: load.equipmentType, pricingModel: load.pricingModel,
          carrierPayoutCents: String(load.grossCarrierCents), platformFeeCents: String(load.platformFeeCents),
          accessorialsCents: String(load.accessorialsCents || 0),
        },
      },
      { idempotencyKey: attempt.idempotencyKey },
    );
  } catch (error) {
    await markAttemptFailed(attempt.id, error instanceof Error ? error.message : "Unknown Stripe error");
    return NextResponse.json({ error: "Failed to create PaymentIntent." }, { status: 502 });
  }

  const status = mapStripeIntentStatus(intent.status);

  await prisma.carrierRoute.update({
    where: { id: load.id },
    data: { stripePaymentIntentId: intent.id, paymentStatus: status },
  });
  await markAttemptCreated(attempt.id, intent.id, status);

  return NextResponse.json({ clientSecret: intent.client_secret, paymentIntentId: intent.id, totalCents, attemptNumber: attempt.attemptNumber });
}
