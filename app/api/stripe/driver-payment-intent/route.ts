import { NextResponse } from "next/server";
import { z } from "zod";
import { stripe, mapStripeIntentStatus } from "@/lib/stripe";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { claimNextPaymentAttempt, markAttemptCreated, markAttemptFailed } from "@/lib/payment-attempts";
import { ensureStripeCustomer } from "@/lib/ensure-stripe-customer";
import { accessorialSumsForLoad } from "@/lib/accessorials/sums";
import { findReusableIntent } from "@/lib/stripe-intent-reuse";
import { ensureQuoteVersion, fundingPaymentMethodTypes } from "@/lib/payments/funding";
import { PAYMENT_POLICY_VERSION, resolvePaymentPolicy } from "@/lib/payments/policy";

/**
 * Server-authoritative: the PaymentIntent amount is built entirely from
 * the already-posted load record, never from client-submitted values.
 * Also verifies the authenticated customer actually posted this load.
 *
 * Same atomic-claim idempotency fix as job-payment-intent — see
 * lib/payment-attempts.ts.
 *
 * Pay before dispatch — VASRUE Digital Media, 29 October 2026. Box-truck
 * and semi loads are now paid in full when posted (automatic capture), not
 * authorised and captured after proof of delivery. A load cannot be claimed
 * or picked up until the funding gate passes (lib/payments/funding.ts); the
 * carrier is still paid only after POD is accepted.
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

  // Step 6: include APPROVED accessorial customer charges in what the customer
  // authorizes. providerShare/platformShare of these are realized on the
  // settlement side (accessorialSumsForLoad), so the money reconciles.
  // (Computed ahead of the guard below so a retry can be checked against it.)
  const accessorials = await accessorialSumsForLoad(load.id);
  const totalCents = load.grossCarrierCents + load.platformFeeCents + (load.accessorialsCents || 0) + accessorials.customerChargeCents;

  if (load.stripePaymentIntentId && load.paymentStatus !== "FAILED" && load.paymentStatus !== "CANCELED") {
    // BLOCK-19 — VASRUE Digital Media, 28 Oct 2026: reuse an intent Stripe is
    // still waiting on, for the current total. See lib/stripe-intent-reuse.ts.
    const reusable = await findReusableIntent(load.stripePaymentIntentId, totalCents);
    if (reusable && reusable.capture_method !== "manual") {
      return NextResponse.json({ clientSecret: reusable.client_secret, paymentIntentId: reusable.id, totalCents, attemptNumber: null, reused: true });
    }
    if (reusable) {
      // Unpaid intent from the old authorise-then-capture flow: retire it.
      await stripe.paymentIntents.cancel(reusable.id, { cancellation_reason: "abandoned" }).catch(() => undefined);
      await prisma.paymentAttempt.updateMany({ where: { stripePaymentIntentId: reusable.id }, data: { paymentStatus: "CANCELED", canceledAt: new Date(), cancelReason: "Replaced under pay-before-dispatch" } });
    } else {
      return NextResponse.json({ error: load.paymentStatus === "CAPTURED" ? "This load is already paid." : "Existing payment must be resolved first." }, { status: 409 });
    }
  }

  const posterUserId = authed.role === "ADMIN" ? load.postedByUserId ?? authed.userId : authed.userId;
  const customerProfile = await prisma.customerProfile.findUnique({ where: { userId: posterUserId } });
  if (!customerProfile) {
    return NextResponse.json({ error: "No customer profile on file for the load poster." }, { status: 409 });
  }
  const stripeCustomerId = await ensureStripeCustomer(prisma, customerProfile.id);

  const marketCode = load.originMarketId ? (await prisma.launchMarket.findUnique({ where: { id: load.originMarketId }, select: { marketCode: true } }))?.marketCode ?? null : null;
  const policy = await resolvePaymentPolicy(marketCode);
  const quote = await ensureQuoteVersion(
    { type: "LOAD", id: load.id },
    {
      totalCents,
      lines: [
        { label: "Carrier linehaul", cents: load.grossCarrierCents },
        { label: "Platform fee", cents: load.platformFeeCents },
        ...((load.accessorialsCents || 0) + accessorials.customerChargeCents ? [{ label: "Accessorials", cents: (load.accessorialsCents || 0) + accessorials.customerChargeCents }] : []),
      ],
      plan: { equipmentType: load.equipmentType, pricingModel: load.pricingModel, carrierPayoutCents: load.grossCarrierCents },
    },
    authed.userId,
  );

  const attempt = await claimNextPaymentAttempt({ loadId: load.id }, "load-payment-intent");

  let intent;
  try {
    intent = await stripe.paymentIntents.create(
      {
        amount: totalCents,
        currency: "usd",
        customer: stripeCustomerId,
        capture_method: "automatic",
        payment_method_types: fundingPaymentMethodTypes({ achEnabled: policy.achEnabled, startsAt: load.pickupDate }),
        description: `TempMovers load ${load.id}`,
        metadata: {
          jobId: load.id, attemptNumber: String(attempt.attemptNumber), vehicleType: load.equipmentType, pricingModel: load.pricingModel,
          carrierPayoutCents: String(load.grossCarrierCents), platformFeeCents: String(load.platformFeeCents),
          accessorialsCents: String(load.accessorialsCents || 0),
          policyVersion: PAYMENT_POLICY_VERSION, quoteVersion: String(quote.version), purpose: "LOAD_FUNDING",
        },
      },
      { idempotencyKey: `${attempt.idempotencyKey}:pbd` },
    );
  } catch (error) {
    await markAttemptFailed(attempt.id, error instanceof Error ? error.message : "Unknown Stripe error");
    return NextResponse.json({ error: "Failed to create PaymentIntent." }, { status: 502 });
  }

  const status = mapStripeIntentStatus(intent.status);

  await prisma.$transaction([
    prisma.carrierRoute.update({ where: { id: load.id }, data: { stripePaymentIntentId: intent.id, paymentStatus: status } }),
    prisma.fundingAttempt.create({
      data: { entityType: "LOAD", entityId: load.id, purpose: "INITIAL", quoteVersionId: quote.id, stripePaymentIntentId: intent.id, amountCents: totalCents, state: "UNPAID" },
    }),
  ]);
  await markAttemptCreated(attempt.id, intent.id, status);

  return NextResponse.json({ clientSecret: intent.client_secret, paymentIntentId: intent.id, totalCents, attemptNumber: attempt.attemptNumber });
}
