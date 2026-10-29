import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { stripe } from "@/lib/stripe";
import { requireRole, AuthError } from "@/lib/auth";
import { ensureStripeCustomer } from "@/lib/ensure-stripe-customer";
import { changeOrderConsentText } from "@/lib/payments/change-orders";
import { PAYMENT_POLICY_VERSION } from "@/lib/payments/policy";

/**
 * Approve and pay a change order — VASRUE Digital Media, 29 October 2026.
 *
 * POST /api/change-orders/[id]/accept (the job's customer). Records the
 * customer's explicit consent and opens a card payment for exactly the
 * change's amount, collected immediately. The order becomes PAID only when
 * Stripe confirms the money (webhook -> syncFundingAttempt); until then the
 * added work does not start (payment spec §3, §6). Calling again while the
 * payment is unfinished hands back the same payment.
 */
export async function POST(request: Request, context: { params: Promise<{ changeOrderId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["CUSTOMER", "ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { changeOrderId } = await context.params;

  const order = await prisma.changeOrder.findUnique({ where: { id: changeOrderId } });
  if (!order || order.entityType !== "JOB") return NextResponse.json({ error: "Change not found." }, { status: 404 });
  const job = await prisma.job.findUnique({ where: { id: order.entityId }, include: { customer: true } });
  if (!job) return NextResponse.json({ error: "Job not found." }, { status: 404 });
  if (authed.role === "CUSTOMER" && job.customer.userId !== authed.userId) return NextResponse.json({ error: "Not your job." }, { status: 403 });
  if (order.status === "PAID") return NextResponse.json({ error: "This change is already paid." }, { status: 409 });
  if (order.status === "DECLINED" || order.status === "CANCELED") return NextResponse.json({ error: `This change was ${order.status.toLowerCase()}.` }, { status: 409 });

  // Unfinished payment from an earlier click: hand it back.
  const existing = await prisma.fundingAttempt.findUnique({ where: { changeOrderId: order.id } });
  if (existing) {
    const intent = await stripe.paymentIntents.retrieve(existing.stripePaymentIntentId);
    if (["requires_payment_method", "requires_confirmation", "requires_action"].includes(intent.status)) {
      return NextResponse.json({ clientSecret: intent.client_secret, paymentIntentId: intent.id, totalCents: order.deltaCents, reused: true });
    }
    return NextResponse.json({ error: intent.status === "processing" ? "The payment for this change is processing." : "This change already has a payment." }, { status: 409 });
  }

  const customerId = await ensureStripeCustomer(prisma, job.customerId);
  const consentText = changeOrderConsentText(order.deltaCents);
  const intent = await stripe.paymentIntents.create(
    {
      amount: order.deltaCents,
      currency: "usd",
      customer: customerId,
      capture_method: "automatic",
      payment_method_types: ["card"],
      description: `TempMovers change ${order.version} on booking ${job.id}`,
      metadata: { type: "CHANGE_ORDER", changeOrderId: order.id, jobId: job.id, kind: order.kind, policyVersion: PAYMENT_POLICY_VERSION },
    },
    { idempotencyKey: `change-order:${order.id}` },
  );

  await prisma.$transaction([
    prisma.changeOrder.update({ where: { id: order.id }, data: { status: "ACCEPTED", acceptedAt: new Date(), acceptedByUserId: authed.userId, consentText } }),
    prisma.fundingAttempt.create({
      data: { entityType: "JOB", entityId: job.id, purpose: "CHANGE_ORDER", changeOrderId: order.id, stripePaymentIntentId: intent.id, amountCents: order.deltaCents, state: "UNPAID" },
    }),
    prisma.auditLog.create({ data: { actorId: authed.userId, jobId: job.id, action: "CHANGE_ORDER_ACCEPTED", entityType: "ChangeOrder", entityId: order.id, details: { deltaCents: order.deltaCents, consentText } } }),
  ]);

  return NextResponse.json({ clientSecret: intent.client_secret, paymentIntentId: intent.id, totalCents: order.deltaCents, consentText }, { status: 201 });
}
