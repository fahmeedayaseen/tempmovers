import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";

const schema = z.object({
  decision: z.enum(["approve", "deny", "pay"]),
  denialReason: z.string().optional(),
});

/**
 * Bonus ledger sign convention (see lib/bonus-ledger.ts for the balance
 * aggregation that depends on this being consistent):
 * - AWARD: positive amountCents — records the liability when a bonus is
 *   approved (not yet paid).
 * - PAYMENT: negative amountCents, equal magnitude to AWARD — records the
 *   liability being discharged when actually paid. Nets to zero against
 *   the AWARD entry once paid, so a paid-and-not-refunded bonus contributes
 *   nothing to the running balance.
 * - RECOVERY: negative amountCents — a refund/chargeback on an
 *   already-PAID award; pushes the balance negative (money owed back).
 * - ADJUSTMENT: positive amountCents — recovery actually collected against
 *   a payout; brings the balance back toward zero.
 *
 * Before this fix, nothing ever created AWARD or PAYMENT entries, and no
 * path ever set a BonusAward to PAID — meaning the RECOVERY path in
 * lib/bonus-ledger.ts was unreachable in practice; every award would hit
 * the PENDING/EARNED/APPROVED -> VOIDED branch on refund instead, since it
 * could never actually be PAID.
 */
export async function POST(request: Request, context: { params: Promise<{ awardId: string }> }) {
  let admin;
  try {
    admin = await requireRole(request, ["ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { awardId } = await context.params;
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const { decision, denialReason } = parsed.data;
  const approvedById = admin.userId;

  const award = await prisma.bonusAward.findUnique({ where: { id: awardId } });
  if (!award) return NextResponse.json({ error: "Bonus award not found." }, { status: 404 });

  if (decision === "pay") {
    if (award.status !== "APPROVED") {
      return NextResponse.json({ error: `Award must be APPROVED before it can be paid (currently ${award.status}).` }, { status: 409 });
    }
    const [updated] = await prisma.$transaction([
      prisma.bonusAward.update({ where: { id: awardId }, data: { status: "PAID", paidAt: new Date() } }),
      prisma.bonusLedgerEntry.create({
        data: { bonusAwardId: awardId, type: "PAYMENT", amountCents: -award.amountCents, reason: "Bonus paid" },
      }),
    ]);
    await prisma.auditLog.create({
      data: { actorId: approvedById, action: "BONUS_AWARD_PAID", entityType: "BonusAward", entityId: awardId, details: { amountCents: award.amountCents } },
    });
    return NextResponse.json({ award: updated });
  }

  if (award.status !== "PENDING" && award.status !== "EARNED") {
    return NextResponse.json({ error: `Award already ${award.status.toLowerCase()}.` }, { status: 409 });
  }

  if (decision === "approve") {
    const [updated] = await prisma.$transaction([
      prisma.bonusAward.update({ where: { id: awardId }, data: { status: "APPROVED", approvedAt: new Date(), approvedById } }),
      prisma.bonusLedgerEntry.create({
        data: { bonusAwardId: awardId, type: "AWARD", amountCents: award.amountCents, reason: "Bonus approved" },
      }),
    ]);
    await prisma.auditLog.create({
      data: { actorId: approvedById, action: "BONUS_AWARD_APPROVED", entityType: "BonusAward", entityId: awardId, details: { amountCents: award.amountCents, decision } },
    });
    return NextResponse.json({ award: updated });
  }

  const updated = await prisma.bonusAward.update({
    where: { id: awardId },
    data: { status: "VOIDED", approvedById, denialReason: denialReason ?? "Denied by admin." },
  });
  await prisma.auditLog.create({
    data: { actorId: approvedById, action: "BONUS_AWARD_DENIED", entityType: "BonusAward", entityId: awardId, details: { amountCents: award.amountCents, decision } },
  });
  return NextResponse.json({ award: updated });
}
