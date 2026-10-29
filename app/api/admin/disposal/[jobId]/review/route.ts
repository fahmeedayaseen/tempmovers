import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { applyDisposalReview } from "@/lib/payments/settlement";

/**
 * Review a held junk disposal — VASRUE Digital Media, 29 October 2026.
 *
 * POST /api/admin/disposal/[jobId]/review (admin). Approve the amount
 * (capped at the funded allowance when it settles), or reject it. Approving
 * without a receipt needs waiveReceipt and a note, and writes an audited
 * RECEIPT_WAIVER exception: missing receipts are held, never silently paid
 * (payment spec §6). If the job is already settled, the reimbursement and
 * any refund of unused allowance follow immediately.
 */
const schema = z.object({
  decision: z.enum(["APPROVE", "REJECT"]),
  approvedCents: z.number().int().min(0).max(1_000_000).optional(),
  waiveReceipt: z.boolean().optional(),
  note: z.string().trim().min(5).max(1000),
});

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { jobId } = await context.params;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const disposal = await prisma.disposalExpense.findUnique({ where: { jobId } });
  if (!disposal) return NextResponse.json({ error: "No disposal record on this job." }, { status: 404 });
  if (disposal.state === "APPROVED" || disposal.state === "REJECTED") return NextResponse.json({ error: "Already reviewed." }, { status: 409 });

  if (parsed.data.decision === "APPROVE") {
    const amount = parsed.data.approvedCents ?? disposal.actualCents;
    if (amount == null) return NextResponse.json({ error: "Give the approved amount; the hauler hasn't entered one." }, { status: 400 });
    if (!disposal.receiptKey && !parsed.data.waiveReceipt) return NextResponse.json({ error: "There is no receipt. Approve only with waiveReceipt and a note explaining why." }, { status: 409 });
    if (!disposal.receiptKey) {
      await prisma.paymentException.create({ data: { entityType: "JOB", entityId: jobId, kind: "RECEIPT_WAIVER", reason: parsed.data.note, authorizedByUserId: authed.userId } });
    }
    await prisma.disposalExpense.update({ where: { id: disposal.id }, data: { state: "APPROVED", actualCents: amount, reviewedByUserId: authed.userId, reviewedAt: new Date(), reviewNote: parsed.data.note } });
  } else {
    await prisma.disposalExpense.update({ where: { id: disposal.id }, data: { state: "REJECTED", reviewedByUserId: authed.userId, reviewedAt: new Date(), reviewNote: parsed.data.note } });
  }
  await prisma.auditLog.create({ data: { actorId: authed.userId, jobId, action: "DISPOSAL_REVIEWED", entityType: "DisposalExpense", entityId: disposal.id, details: { decision: parsed.data.decision, approvedCents: parsed.data.approvedCents ?? disposal.actualCents, receiptWaived: !disposal.receiptKey && parsed.data.decision === "APPROVE", note: parsed.data.note } } });

  const applied = await applyDisposalReview(jobId, authed.userId);
  return NextResponse.json({ reviewed: parsed.data.decision, appliedToSettlement: !!applied, reimbursedCents: applied?.reimbursedCents ?? null, refundedCents: applied?.refund?.refundedCents ?? 0 });
}
