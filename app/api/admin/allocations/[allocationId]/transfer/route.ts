import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { stripe } from "@/lib/stripe";
import { requireRole, AuthError } from "@/lib/auth";
import { evaluateFunding } from "@/lib/payments/funding";
import { captureIntegrationAlert } from "@/lib/monitoring";

/**
 * Pay a disposal reimbursement — VASRUE Digital Media, 29 October 2026.
 *
 * POST /api/admin/allocations/[id]/transfer (admin). Transfers a junk job's
 * approved disposal reimbursement to the hauler's connected account, on its
 * own, after the dump receipt is approved (payment spec §6–§7): so a missing
 * receipt holds only the reimbursement, never the hauler's service pay. One
 * transfer per allocation, enforced by Stripe's idempotency key and our own
 * state check.
 */
export async function POST(request: Request, context: { params: Promise<{ allocationId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { allocationId } = await context.params;
  const allocation = await prisma.paymentAllocation.findUnique({ where: { id: allocationId } });
  if (!allocation) return NextResponse.json({ error: "Allocation not found." }, { status: 404 });
  if (allocation.recipient !== "DISPOSAL") return NextResponse.json({ error: "Only disposal reimbursements are transferred here; worker pay goes through payouts." }, { status: 409 });
  if (allocation.state === "TRANSFERRED") return NextResponse.json({ error: "Already transferred." }, { status: 409 });
  if (allocation.state !== "APPROVED_AWAITING_FUNDS") return NextResponse.json({ error: "This reimbursement is held until its receipt is approved." }, { status: 409 });
  if (allocation.amountCents <= 0 || !allocation.workerId) return NextResponse.json({ error: "Nothing to transfer." }, { status: 409 });

  const worker = await prisma.workerProfile.findUnique({ where: { id: allocation.workerId } });
  if (!worker?.stripeAccountId || !worker.stripePayoutsEnabled) return NextResponse.json({ error: "The hauler hasn't finished Stripe Connect onboarding." }, { status: 409 });
  if (worker.operationalStatus === "SUSPENDED" || worker.operationalStatus === "CLOSED") return NextResponse.json({ error: "The hauler's account is on hold." }, { status: 409 });

  const funding = await evaluateFunding({ type: allocation.entityType, id: allocation.entityId }, { refresh: true });
  if (funding.disputedCents > 0) return NextResponse.json({ error: "A payment on this job is disputed; the reimbursement is held." }, { status: 409 });
  const source = await prisma.fundingAttempt.findFirst({ where: { entityType: allocation.entityType, entityId: allocation.entityId, purpose: "INITIAL", stripeChargeId: { not: null } }, orderBy: { createdAt: "asc" } });

  const idempotencyKey = `allocation:${allocation.id}`;
  const claim = await prisma.paymentAllocation.updateMany({ where: { id: allocation.id, state: "APPROVED_AWAITING_FUNDS" }, data: { state: "RELEASED", transferIdempotencyKey: idempotencyKey } });
  if (claim.count !== 1) return NextResponse.json({ error: "Transfer already in progress." }, { status: 409 });

  try {
    const transfer = await stripe.transfers.create(
      {
        amount: allocation.amountCents, currency: "usd", destination: worker.stripeAccountId,
        ...(source?.stripeChargeId && { source_transaction: source.stripeChargeId }),
        metadata: { allocationId: allocation.id, purpose: "DISPOSAL_REIMBURSEMENT", jobId: allocation.entityId, workerId: worker.id },
      },
      { idempotencyKey },
    );
    const done = await prisma.paymentAllocation.update({ where: { id: allocation.id }, data: { state: "TRANSFERRED", stripeTransferId: transfer.id, transferredAt: new Date() } });
    await prisma.auditLog.create({ data: { actorId: authed.userId, action: "DISPOSAL_REIMBURSED", entityType: "PaymentAllocation", entityId: allocation.id, details: { amountCents: allocation.amountCents, stripeTransferId: transfer.id } } });
    return NextResponse.json({ allocation: done, transferred: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await prisma.paymentAllocation.update({ where: { id: allocation.id }, data: { state: "APPROVED_AWAITING_FUNDS" } });
    captureIntegrationAlert("Disposal reimbursement transfer failed; it can be retried.", { area: "payout", allocationId: allocation.id, error: message });
    return NextResponse.json({ error: `Transfer failed: ${message}` }, { status: 502 });
  }
}
