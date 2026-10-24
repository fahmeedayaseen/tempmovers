import { prisma } from "@/lib/db";
import { FULL_ASSIGNED_LOAD_SELECT } from "@/lib/access/sanitize-load";

/**
 * The atomic "claim this freight load for this worker" operation —
 * extracted from POST /api/loads/[loadId]/request so both the open
 * board's request flow and freight invitation acceptance use the exact
 * same atomic claim, rather than two independent implementations of
 * the same race-safety logic that could drift apart. The WHERE clause
 * re-checks status AND that no one else has claimed the load in the
 * same statement as the update — if two attempts race here, only one
 * updateMany call can match, and the loser gets a clean, typed error
 * instead of silently overwriting the winner's assignment.
 */
export type FreightClaimResult =
  | { ok: true; load: Record<string, unknown> }
  | { ok: false; reason: "LOAD_ALREADY_ASSIGNED" };

export async function claimFreightLoad(loadId: string, workerId: string, actorUserId: string, auditAction: string): Promise<FreightClaimResult> {
  try {
    const load = await prisma.$transaction(async (tx) => {
      const claim = await tx.carrierRoute.updateMany({
        where: { id: loadId, status: { in: ["OPEN", "OFFER_RECEIVED"] }, assignedWorkerId: null },
        data: { status: "ASSIGNED", assignedWorkerId: workerId },
      });
      if (claim.count !== 1) throw new Error("LOAD_ALREADY_ASSIGNED");

      const assigned = await tx.carrierRoute.findUniqueOrThrow({ where: { id: loadId }, select: FULL_ASSIGNED_LOAD_SELECT });
      await tx.auditLog.create({
        data: { actorId: actorUserId, action: auditAction, entityType: "CarrierRoute", entityId: loadId, details: { workerId } },
      });
      return assigned;
    });
    return { ok: true, load };
  } catch (e) {
    if (e instanceof Error && e.message === "LOAD_ALREADY_ASSIGNED") return { ok: false, reason: "LOAD_ALREADY_ASSIGNED" };
    throw e;
  }
}
