import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { captureIntegrationAlert } from "@/lib/monitoring";
import { evaluateFunding, syncFundingAttempt } from "@/lib/payments/funding";
import { resolvePaymentPolicy } from "@/lib/payments/policy";

/**
 * Funding reconciliation — VASRUE Digital Media, 29 October 2026.
 *
 * Daily (payment spec §8): re-reads recent funding payments from Stripe so a
 * missed webhook can't leave the ledger wrong, then alerts on what needs a
 * person — crewed or started jobs that are not funded, payments stuck
 * processing, settlements whose allocations don't add up to what was
 * collected, and completed work waiting past the review window. It flags; it
 * never moves money.
 */
export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  const provided = request.headers.get("authorization")?.replace("Bearer ", "");
  if (!secret || provided !== secret) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const now = Date.now();
  const findings: Record<string, unknown[]> = { resynced: [], underfundedDispatched: [], stuckProcessing: [], unbalancedSettlements: [], overdueReview: [] };

  // 1. Re-read the last two weeks of funding payments from Stripe.
  const recent = await prisma.fundingAttempt.findMany({ where: { createdAt: { gte: new Date(now - 14 * 86_400_000) } }, orderBy: { createdAt: "desc" }, take: 100 });
  for (const a of recent) {
    try {
      const after = await syncFundingAttempt(a.stripePaymentIntentId);
      if (after && (after.state !== a.state || after.refundedCents !== a.refundedCents)) findings.resynced.push({ attemptId: a.id, from: a.state, to: after.state });
    } catch (e) {
      captureIntegrationAlert("Funding reconciliation could not read a payment from Stripe.", { area: "payment", attemptId: a.id, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // 2. Crewed or started jobs that are not funded.
  const active = await prisma.job.findMany({ where: { status: { in: ["PARTIALLY_FILLED", "CONFIRMED", "IN_PROGRESS"] } }, select: { id: true, status: true }, take: 500 });
  for (const j of active) {
    const f = await evaluateFunding({ type: "JOB", id: j.id });
    if (!f.funded) findings.underfundedDispatched.push({ jobId: j.id, status: j.status, label: f.label, shortfallCents: f.shortfallCents });
  }

  // 3. Payments still processing after three days.
  const stuck = await prisma.fundingAttempt.findMany({ where: { state: "PROCESSING", updatedAt: { lt: new Date(now - 3 * 86_400_000) } }, select: { id: true, entityType: true, entityId: true } });
  findings.stuckProcessing.push(...stuck);

  // 4. Settlements that don't balance.
  const settlements = await prisma.paymentSettlement.findMany({ where: { settledAt: { gte: new Date(now - 30 * 86_400_000) } }, select: { id: true, entityType: true, entityId: true, collectedCents: true } });
  for (const s of settlements) {
    const sum = await prisma.paymentAllocation.aggregate({ where: { settlementId: s.id }, _sum: { amountCents: true } });
    if ((sum._sum.amountCents ?? 0) !== s.collectedCents) findings.unbalancedSettlements.push({ settlementId: s.id, collectedCents: s.collectedCents, allocatedCents: sum._sum.amountCents ?? 0 });
  }

  // 5. Checked-out work waiting past the review window with no approval.
  const policy = await resolvePaymentPolicy(null);
  const overdue = await prisma.assignment.findMany({ where: { status: "CHECKED_OUT", checkOutAt: { lt: new Date(now - policy.reviewWindowHours * 3_600_000) } }, select: { id: true, jobId: true, checkOutAt: true }, take: 200 });
  findings.overdueReview.push(...overdue);

  const problems = findings.underfundedDispatched.length + findings.stuckProcessing.length + findings.unbalancedSettlements.length + findings.overdueReview.length;
  if (problems > 0) {
    captureIntegrationAlert("Funding reconciliation found items that need review.", {
      area: "payment",
      underfundedDispatched: findings.underfundedDispatched.length, stuckProcessing: findings.stuckProcessing.length,
      unbalancedSettlements: findings.unbalancedSettlements.length, overdueReview: findings.overdueReview.length,
    });
  }
  return NextResponse.json({ ok: true, problems, findings });
}

// Vercel Cron calls scheduled routes with GET and the same bearer secret.
export const GET = POST;
