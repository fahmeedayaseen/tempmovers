import { NextResponse } from "next/server";
import { z } from "zod";
import { createHash } from "crypto";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { resolvePaymentPolicy, marketCodeForJob } from "@/lib/payments/policy";
import { applyDisposalReview } from "@/lib/payments/settlement";
import { fundedDisposalAllowance } from "@/lib/payments/change-orders";
import { JUNK_ALLOCATION_MODEL, type JunkQuotePlan } from "@/lib/junk/full-quote";

/**
 * Junk disposal amount — VASRUE Digital Media, 29 October 2026.
 *
 * POST /api/junk/assignments/[assignmentId]/disposal (the job's hauler).
 * Records what the dump actually cost, against the receipt uploaded through
 * POST /api/junk/assignments/[id]/proof (junk spec §5a, §7; payment spec §6):
 *
 *   * receipt on file and at or under the funded allowance (and under the
 *     market's auto-approve cap): approved; any unused allowance goes back to
 *     the customer in full and the hauler is reimbursed the actual amount;
 *   * no receipt, or over the allowance, or over the cap: held for admin review.
 *     Over the allowance means a change order should have been paid before
 *     the dump; the customer is never charged after the fact.
 *
 * One disposal record per job, tied to the job, the payee and the amount, so
 * a reimbursement can only ever be paid once.
 */
const schema = z.object({ actualCents: z.number().int().min(0).max(1_000_000), note: z.string().trim().max(500).optional() });

export async function POST(request: Request, context: { params: Promise<{ assignmentId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["MOVER", "DRIVER"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { assignmentId } = await context.params;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Enter the disposal amount in cents." }, { status: 400 });

  const assignment = await prisma.assignment.findUnique({
    where: { id: assignmentId },
    select: { id: true, jobId: true, workerId: true, status: true, junkCrewRole: true, worker: { select: { userId: true } } },
  });
  if (!assignment || assignment.worker.userId !== authed.userId) return NextResponse.json({ error: "Not your assignment." }, { status: 403 });
  if (assignment.junkCrewRole !== "HAULER") return NextResponse.json({ error: "Only the hauler records the disposal amount." }, { status: 403 });
  if (!["CHECKED_IN", "CHECKED_OUT", "APPROVED"].includes(assignment.status)) return NextResponse.json({ error: "Check in on the job first." }, { status: 409 });

  const [job, detail, quote, disposal] = await Promise.all([
    prisma.job.findUnique({ where: { id: assignment.jobId }, select: { id: true, marketId: true } }),
    prisma.junkRemovalDetail.findUnique({ where: { jobId: assignment.jobId }, select: { dumpReceiptKey: true } }),
    prisma.quoteVersion.findFirst({ where: { entityType: "JOB", entityId: assignment.jobId }, orderBy: { version: "desc" } }),
    prisma.disposalExpense.findUnique({ where: { jobId: assignment.jobId } }),
  ]);
  const plan = quote?.plan as unknown as JunkQuotePlan | null;
  if (!job || !plan || plan.model !== JUNK_ALLOCATION_MODEL || !disposal) {
    return NextResponse.json({ error: "This job was booked before disposal tracking; nothing to record." }, { status: 409 });
  }
  if (disposal.state === "APPROVED" || disposal.state === "REJECTED") return NextResponse.json({ error: "The disposal on this job has already been reviewed." }, { status: 409 });

  const allowance = await fundedDisposalAllowance(job.id, plan);
  const policy = await resolvePaymentPolicy(await marketCodeForJob(job));
  const receiptKey = detail?.dumpReceiptKey ?? null;
  const fingerprint = receiptKey ? createHash("sha256").update(`${job.id}|${receiptKey}`).digest("hex") : null;

  const reasons: string[] = [];
  if (!receiptKey) reasons.push("No dump receipt is on file yet.");
  if (parsed.data.actualCents > allowance) reasons.push(`The amount is over the funded allowance of ${(allowance / 100).toFixed(2)}; overage needed an approved, paid change order before the dump.`);
  if (parsed.data.actualCents > policy.disposalAutoApproveCents) reasons.push("Above the auto-approve limit; an admin reviews it.");
  const autoApprove = reasons.length === 0;

  const updated = await prisma.disposalExpense.update({
    where: { id: disposal.id },
    data: {
      actualCents: parsed.data.actualCents,
      receiptKey,
      receiptFingerprint: fingerprint,
      payeeWorkerId: assignment.workerId,
      state: autoApprove ? "APPROVED" : receiptKey ? "RECEIPT_SUBMITTED" : "HELD",
      submittedAt: new Date(),
      reviewedAt: autoApprove ? new Date() : null,
      reviewNote: autoApprove ? "Auto-approved: receipt on file, within the allowance." : reasons.join(" ") + (parsed.data.note ? ` Hauler note: ${parsed.data.note}` : ""),
    },
  });
  await prisma.auditLog.create({ data: { actorId: authed.userId, jobId: job.id, action: "DISPOSAL_SUBMITTED", entityType: "DisposalExpense", entityId: updated.id, details: { actualCents: parsed.data.actualCents, allowanceCents: allowance, state: updated.state, receipt: !!receiptKey } } });

  const applied = autoApprove ? await applyDisposalReview(job.id, authed.userId) : null;
  return NextResponse.json({
    disposal: { state: updated.state, actualCents: updated.actualCents, allowanceCents: allowance, unusedCents: Math.max(0, allowance - parsed.data.actualCents) },
    held: !autoApprove,
    reasons,
    refundedCents: applied?.refund?.refundedCents ?? 0,
  }, { status: 201 });
}
