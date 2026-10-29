import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { stripe } from "@/lib/stripe";
import { requireRole, AuthError } from "@/lib/auth";
import { evaluateFunding } from "@/lib/payments/funding";
import { refundCollectedFunds } from "@/lib/payments/refunds";

/**
 * Cancel a booking before service starts — VASRUE Digital Media, 29 Oct 2026.
 *
 * POST /api/jobs/[jobId]/cancel (the job's customer, or admin). Payment spec
 * §7: before dispatch the booking is refunded under the accepted cancellation
 * policy. No cancellation fee is enabled until Carl approves its amount and
 * cutoff, so today that is a full refund, booking protection included. Once
 * any crew member has checked in, cancellation is an admin matter (verified
 * work is itemised and the balance refunded) and this route refuses.
 */
const schema = z.object({ reason: z.string().trim().min(3).max(500) });

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["CUSTOMER", "ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { jobId } = await context.params;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Tell us briefly why you're canceling." }, { status: 400 });

  const job = await prisma.job.findUnique({ where: { id: jobId }, include: { customer: true, assignments: true } });
  if (!job) return NextResponse.json({ error: "Job not found." }, { status: 404 });
  if (authed.role === "CUSTOMER" && job.customer.userId !== authed.userId) return NextResponse.json({ error: "Not your job." }, { status: 403 });
  if (job.status === "CANCELED") return NextResponse.json({ error: "This booking is already canceled." }, { status: 409 });
  if (job.status === "COMPLETED") return NextResponse.json({ error: "A completed job can't be canceled." }, { status: 409 });
  if (job.assignments.some((a) => ["CHECKED_IN", "CHECKED_OUT", "APPROVED"].includes(a.status))) {
    return NextResponse.json({ error: "The crew has already started. Contact support to cancel; any verified work is itemised and the rest refunded." }, { status: 409 });
  }

  const funding = await evaluateFunding({ type: "JOB", id: jobId }, { refresh: true });

  await prisma.$transaction([
    prisma.job.update({ where: { id: jobId }, data: { status: "CANCELED" } }),
    prisma.assignment.updateMany({ where: { jobId, status: { in: ["INVITED", "APPLIED", "ACCEPTED"] } }, data: { status: "CANCELED" } }),
    prisma.changeOrder.updateMany({ where: { entityType: "JOB", entityId: jobId, status: { in: ["PROPOSED", "ACCEPTED"] } }, data: { status: "CANCELED" } }),
    prisma.auditLog.create({ data: { actorId: authed.userId, jobId, action: "JOB_CANCELED_BEFORE_DISPATCH", entityType: "Job", entityId: jobId, details: { reason: parsed.data.reason, availableCents: funding.availableCents, cancellationFeeCents: 0 } } }),
  ]);

  // Anything still waiting for the customer's card is simply canceled.
  const pending = await prisma.fundingAttempt.findMany({ where: { entityType: "JOB", entityId: jobId, state: { in: ["UNPAID", "ACTION_REQUIRED", "FAILED"] } } });
  for (const p of pending) {
    await stripe.paymentIntents.cancel(p.stripePaymentIntentId, { cancellation_reason: "requested_by_customer" }).catch(() => undefined);
  }
  // A legacy authorisation is released rather than captured.
  if (job.paymentStatus === "AUTHORIZED" && job.stripePaymentIntentId && pending.length === 0 && funding.attempts.length === 0) {
    await stripe.paymentIntents.cancel(job.stripePaymentIntentId, { cancellation_reason: "requested_by_customer" }).catch(() => undefined);
  }

  const refund = funding.availableCents > 0
    ? await refundCollectedFunds({ ref: { type: "JOB", id: jobId }, amountCents: funding.availableCents, reason: `Canceled before dispatch: ${parsed.data.reason}`, purposeKey: `cancel:${jobId}`, actorUserId: authed.userId })
    : null;

  return NextResponse.json({ canceled: true, refundedCents: refund?.refundedCents ?? 0, refundFailures: refund?.failures ?? [] });
}
