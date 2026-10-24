import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";

/**
 * Lists individual worker Payouts and freight Settlements ready to be
 * paid (SCHEDULED, or FAILED for a safe retry) — the same
 * missing-lookup pattern as the refund console and capture queue: the
 * pay routes (payouts/[id]/pay, settlements/[id]/pay) were already
 * correct, there was just no way for an admin to find what's eligible.
 */
export async function GET(request: Request) {
  try {
    await requireRole(request, ["ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const [payouts, settlements] = await Promise.all([
    prisma.payout.findMany({
      where: { status: { in: ["SCHEDULED", "FAILED"] } },
      select: { id: true, netPayoutCents: true, status: true, failureReason: true, worker: { select: { displayName: true, stripePayoutsEnabled: true } } },
      orderBy: { createdAt: "asc" },
      take: 50,
    }),
    prisma.settlement.findMany({
      where: { status: { in: ["SCHEDULED", "FAILED"] } },
      select: { id: true, netCents: true, status: true, failureReason: true, loadsSettled: true, worker: { select: { displayName: true, stripePayoutsEnabled: true } } },
      orderBy: { createdAt: "asc" },
      take: 50,
    }),
  ]);

  return NextResponse.json({
    payouts: payouts.map((p) => ({
      id: p.id, type: "payout" as const, workerName: p.worker.displayName ?? "Unnamed worker",
      amountCents: p.netPayoutCents, status: p.status, failureReason: p.failureReason,
      connectReady: p.worker.stripePayoutsEnabled,
    })),
    settlements: settlements.map((s) => ({
      id: s.id, type: "settlement" as const, workerName: s.worker.displayName ?? "Unnamed worker",
      amountCents: s.netCents, status: s.status, failureReason: s.failureReason, loadsSettled: s.loadsSettled,
      connectReady: s.worker.stripePayoutsEnabled,
    })),
  });
}
