import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { stripe, mapStripeIntentStatus } from "@/lib/stripe";
import { requireRole, AuthError } from "@/lib/auth";
import { captureIntegrationAlert } from "@/lib/monitoring";
import { ensureStripeCustomer } from "@/lib/ensure-stripe-customer";

/**
 * Charges the already-approved detention amount via a SEPARATE, supplemental
 * PaymentIntent — this never touches or modifies the load's original
 * PaymentIntent/authorization. Per the explicit caution carried over from
 * an earlier pass: silently increasing an existing authorization has its
 * own capture-strategy implications; a distinct, clearly-labeled
 * supplemental charge is the safer default that doesn't require guessing
 * at those.
 *
 * Hardened from the previous version: the PaymentIntent ID and status now
 * land in a durable DetentionCharge row, not only the audit log — this is
 * what makes the charge's outcome queryable and what the Stripe webhook
 * updates once the off-session confirmation actually resolves. metadata
 * now uses loadId (this is a CarrierRoute, not a Job) for clarity and
 * correct webhook routing.
 */
export async function POST(request: Request, context: { params: Promise<{ loadId: string }> }) {
  let admin;
  try {
    admin = await requireRole(request, ["ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { loadId } = await context.params;

  const load = await prisma.carrierRoute.findUnique({ where: { id: loadId } });
  if (!load) return NextResponse.json({ error: "Load not found." }, { status: 404 });
  if (!load.detentionApprovedAt || !load.detentionApprovedById) {
    return NextResponse.json({ error: "Detention must be approved before it can be charged." }, { status: 409 });
  }
  if (load.detentionCents <= 0) {
    return NextResponse.json({ error: "No detention amount to charge." }, { status: 409 });
  }
  if (!load.postedByUserId) {
    return NextResponse.json({ error: "Load has no poster to bill." }, { status: 409 });
  }

  const existingCharge = await prisma.detentionCharge.findFirst({
    where: { loadId: load.id, paymentStatus: { not: "FAILED" } },
  });
  if (existingCharge) {
    return NextResponse.json({ error: "Detention for this load already has an unresolved or successful charge." }, { status: 409 });
  }

  const customerProfile = await prisma.customerProfile.findUnique({ where: { userId: load.postedByUserId } });
  if (!customerProfile) {
    return NextResponse.json({ error: "No customer profile on file for the load poster." }, { status: 409 });
  }
  const stripeCustomerId = await ensureStripeCustomer(prisma, customerProfile.id);

  let intent;
  try {
    intent = await stripe.paymentIntents.create(
      {
        amount: load.detentionCents,
        currency: "usd",
        customer: stripeCustomerId,
        confirm: true,
        off_session: true,
        metadata: {
          loadId: load.id, type: "DETENTION_CHARGE",
          actualWaitTimeMinutes: String(load.actualWaitTimeMinutes ?? 0),
          approvedById: load.detentionApprovedById,
        },
      },
      { idempotencyKey: `detention-charge:${load.id}` },
    );
  } catch (error) {
    // An off-session confirmation can fail outright (card declined,
    // authentication required with no way to prompt the customer here).
    // Record the failed attempt as its own DetentionCharge row rather than
    // losing the failure — this is what a customer-action-required
    // workflow would query to find charges that need the customer to step
    // back in, instead of the failure only ever existing as a thrown error.
    const message = error instanceof Error ? error.message : "Unknown Stripe error";
    await prisma.detentionCharge.create({
      data: {
        loadId: load.id, amountCents: load.detentionCents,
        stripePaymentIntentId: `failed:${load.id}:${Date.now()}`,
        paymentStatus: "FAILED", failureReason: message,
        approvedById: load.detentionApprovedById, approvedAt: load.detentionApprovedAt,
      },
    });
    captureIntegrationAlert("Supplemental detention charge failed off-session — customer action required.", {
      area: "payout", loadId: load.id, error: message,
    });
    return NextResponse.json({ error: `Detention charge failed: ${message}. The customer may need to update their payment method.` }, { status: 402 });
  }

  const paymentStatus = mapStripeIntentStatus(intent.status);
  const charge = await prisma.detentionCharge.create({
    data: {
      loadId: load.id, amountCents: load.detentionCents, stripePaymentIntentId: intent.id,
      paymentStatus, approvedById: load.detentionApprovedById, approvedAt: load.detentionApprovedAt,
      paidAt: paymentStatus === "CAPTURED" ? new Date() : null,
    },
  });

  await prisma.auditLog.create({
    data: {
      action: "DETENTION_CHARGED", entityType: "DetentionCharge", entityId: charge.id,
      details: { loadId: load.id, detentionCents: load.detentionCents, stripePaymentIntentId: intent.id, status: intent.status },
    },
  });

  if (paymentStatus !== "CAPTURED") {
    captureIntegrationAlert("Supplemental detention charge did not settle immediately — needs reconciliation via webhook.", {
      area: "payout", loadId: load.id, detentionChargeId: charge.id, stripeStatus: intent.status,
    });
  }

  return NextResponse.json({ detentionChargeId: charge.id, paymentIntentId: intent.id, status: intent.status, detentionCents: load.detentionCents });
}
