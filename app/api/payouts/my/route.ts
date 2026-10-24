import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";

/**
 * Read-only payout history for the authenticated worker — previously
 * there was no way for a worker to see their own payout status in-app
 * at all, despite the full PayoutStatus lifecycle (including the P1-08
 * PAID_OUT addition) being real and correctly tracked in the database.
 *
 * Returns both Payout (individual moving-job earnings) and Settlement
 * (freight earnings) rows, since both share the same PayoutStatus
 * lifecycle and a worker should see one unified history regardless of
 * which type of work produced it.
 */
export async function GET(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["MOVER", "DRIVER"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const worker = await prisma.workerProfile.findUnique({ where: { userId: authed.userId } });
  if (!worker) return NextResponse.json({ error: "No worker profile found for this account." }, { status: 404 });

  const [payouts, settlements] = await Promise.all([
    prisma.payout.findMany({
      where: { workerId: worker.id },
      select: {
        id: true, grossEarningsCents: true, adjustmentsCents: true, recoveryCents: true, netPayoutCents: true,
        status: true, scheduledAt: true, paidAt: true, paidOutAt: true, failureReason: true, reversedAt: true, createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    prisma.settlement.findMany({
      where: { workerId: worker.id },
      select: {
        id: true, periodStart: true, periodEnd: true, loadsSettled: true, grossCents: true, adjustmentsCents: true, netCents: true,
        status: true, approvedAt: true, paidAt: true, paidOutAt: true, failureReason: true, reversedAt: true, createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
  ]);

  return NextResponse.json({
    payouts: payouts.map((p) => ({ ...p, type: "payout" as const })),
    settlements: settlements.map((s) => ({ ...s, type: "settlement" as const, netPayoutCents: s.netCents, grossEarningsCents: s.grossCents })),
  });
}
