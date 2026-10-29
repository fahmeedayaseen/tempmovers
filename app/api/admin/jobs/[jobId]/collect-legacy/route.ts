import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { stripe } from "@/lib/stripe";
import { requireRole, AuthError } from "@/lib/auth";
import { ensureQuoteVersion } from "@/lib/payments/funding";

/**
 * Collect a legacy booking before dispatch — VASRUE Digital Media, 29 Oct 2026.
 *
 * POST /api/admin/jobs/[jobId]/collect-legacy (admin). A moving job booked
 * under the old terms holds only an authorisation, which no longer passes the
 * funding gate. This captures that same authorisation in full — the customer
 * is not charged twice, nothing new is created on their card — and moves the
 * job onto pay-before-dispatch so settlement refunds whatever the approved
 * hours don't use. Junk jobs from the old flat-share model are not converted;
 * they are rebooked.
 */
export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { jobId } = await context.params;
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) return NextResponse.json({ error: "Job not found." }, { status: 404 });
  if (job.type === "JUNK_REMOVAL") return NextResponse.json({ error: "Old-model junk bookings are rebooked, not converted." }, { status: 409 });
  if ((await prisma.fundingAttempt.count({ where: { entityType: "JOB", entityId: jobId } })) > 0) return NextResponse.json({ error: "This job is already on pay-before-dispatch." }, { status: 409 });
  if (!job.stripePaymentIntentId || job.paymentStatus !== "AUTHORIZED") return NextResponse.json({ error: "There is no live authorisation to collect." }, { status: 409 });

  const intent = await stripe.paymentIntents.retrieve(job.stripePaymentIntentId);
  if (intent.status !== "requires_capture") return NextResponse.json({ error: `The authorisation is ${intent.status}; it can't be collected.` }, { status: 409 });

  const quote = await ensureQuoteVersion({ type: "JOB", id: jobId }, { totalCents: intent.amount, lines: [{ label: "Booking total (legacy authorisation)", cents: intent.amount }] }, authed.userId);
  await prisma.fundingAttempt.create({ data: { entityType: "JOB", entityId: jobId, purpose: "INITIAL", quoteVersionId: quote.id, stripePaymentIntentId: intent.id, amountCents: intent.amount, state: "UNPAID" } });
  const captured = await stripe.paymentIntents.capture(intent.id, {}, { idempotencyKey: `legacy-collect:${jobId}` });
  await prisma.auditLog.create({ data: { actorId: authed.userId, jobId, action: "LEGACY_AUTHORIZATION_COLLECTED", entityType: "Job", entityId: jobId, details: { paymentIntentId: intent.id, amountCents: intent.amount, status: captured.status } } });
  return NextResponse.json({ collected: captured.status === "succeeded", status: captured.status, amountCents: intent.amount });
}
