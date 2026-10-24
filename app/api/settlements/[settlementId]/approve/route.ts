import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";

/**
 * Explicit admin sign-off before a settlement can be paid — mirrors the
 * "never auto-pay without a human decision" principle used throughout
 * this codebase (detention charges, document review, worker status
 * changes).
 *
 * Also reconciles totals before approving (added per a V23 audit
 * finding): recomputes gross/net from the settlement's actually-attached
 * loads and detention lines and refuses to approve if the stored totals
 * have drifted from what they should be. This is a real, if unlikely,
 * possibility if a load or detention charge were ever edited after
 * settlement generation, or if a bug elsewhere let totals and
 * attachments disagree — approval is the last real checkpoint before
 * money moves, so it's the right place to catch that rather than
 * silently trusting numbers written earlier.
 */
export async function POST(request: Request, context: { params: Promise<{ settlementId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { settlementId } = await context.params;

  const settlement = await prisma.settlement.findUnique({
    where: { id: settlementId },
    include: { loads: true, detentionLines: true },
  });
  if (!settlement) return NextResponse.json({ error: "Settlement not found." }, { status: 404 });
  if (settlement.status !== "PENDING") {
    return NextResponse.json({ error: `Settlement status ${settlement.status} cannot be approved (must be PENDING).` }, { status: 409 });
  }

  const expectedGrossCents =
    settlement.loads.reduce((sum, load) => sum + load.grossCarrierCents, 0) +
    settlement.detentionLines.reduce((sum, line) => sum + line.amountCents, 0);
  const expectedNetCents = expectedGrossCents + settlement.adjustmentsCents;

  if (settlement.grossCents !== expectedGrossCents || settlement.netCents !== expectedNetCents) {
    return NextResponse.json({
      error: "Settlement totals do not reconcile with its attached loads and detention lines. Do not approve — investigate before proceeding.",
      stored: { grossCents: settlement.grossCents, netCents: settlement.netCents },
      expected: { grossCents: expectedGrossCents, netCents: expectedNetCents },
    }, { status: 409 });
  }

  const updated = await prisma.settlement.update({
    where: { id: settlementId },
    data: { status: "SCHEDULED", approvedAt: new Date(), approvedById: authed.userId },
  });

  await prisma.auditLog.create({
    data: { actorId: authed.userId, action: "SETTLEMENT_APPROVED", entityType: "Settlement", entityId: settlementId, details: { netCents: settlement.netCents } },
  });

  return NextResponse.json({ settlement: updated });
}
