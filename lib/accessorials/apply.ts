import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { computeAccessorial } from "@/lib/accessorials/compute";
import { resolveAccessorialPrice } from "@/lib/accessorials/resolve-price";

/**
 * Shared apply-accessorial logic (P0). Applies one accessorial to a booking
 * (job or load):
 *   1. resolve the AccessorialType (must be active + in scope),
 *   2. resolve the market/effective-dated price row for the booking's market
 *      at `now` (server-side; national fallback),
 *   3. compute the three cent amounts from the frozen shape/rate + quantity,
 *   4. FREEZE everything into a BookingAccessorial, including the price source
 *      (market, version, effectiveFrom) and tax/ledger snapshot.
 * The row starts PROPOSED (a P1 workflow approves it); known-at-booking
 * charges can be created already APPROVED by the caller passing status.
 */
export const applyAccessorialSchema = z.object({
  accessorialTypeId: z.string().cuid(),
  quantity: z.number().positive().default(1),
  status: z.enum(["PROPOSED", "APPROVED"]).optional(),
});

export async function applyAccessorial(params: {
  actorUserId: string;
  booking: { kind: "job"; jobId: string; marketId: string | null } | { kind: "load"; loadId: string; marketId: string | null };
  accessorialTypeId: string;
  quantity: number;
  status?: "PROPOSED" | "APPROVED";
}) {
  const type = await prisma.accessorialType.findUnique({ where: { id: params.accessorialTypeId } });
  if (!type || !type.isActive) return { ok: false as const, status: 404, error: "Accessorial type not found or inactive." };

  const now = new Date();
  const price = await resolveAccessorialPrice(type.id, params.booking.marketId, now);
  if (!price) return { ok: false as const, status: 409, error: "No published price is configured for this accessorial in this market." };

  const charge = computeAccessorial(
    { pricingShape: type.pricingShape, customerRateCents: price.customerRateCents, platformShareMode: type.platformShareMode, platformShareValue: type.platformShareValue, platformCapCents: type.platformCapCents },
    { quantity: params.quantity },
  );

  const created = await prisma.bookingAccessorial.create({
    data: {
      jobId: params.booking.kind === "job" ? params.booking.jobId : null,
      loadId: params.booking.kind === "load" ? params.booking.loadId : null,
      accessorialTypeId: type.id,
      typeKeySnapshot: type.key,
      pricingShapeSnapshot: type.pricingShape,
      customerRateCentsSnapshot: price.customerRateCents,
      platformShareModeSnapshot: type.platformShareMode,
      platformShareValueSnapshot: type.platformShareValue,
      platformCapCentsSnapshot: type.platformCapCents,
      quantity: params.quantity,
      customerChargeCents: charge.customerChargeCents,
      platformShareCents: charge.platformShareCents,
      providerShareCents: charge.providerShareCents,
      priceSourceMarketId: price.marketId,
      priceSourceVersion: price.version,
      priceSourceEffectiveFrom: price.effectiveFrom,
      isTaxableSnapshot: type.isTaxable,
      ledgerCodeSnapshot: type.ledgerCode,
      status: params.status ?? "PROPOSED",
    },
    select: { id: true, status: true, customerChargeCents: true, platformShareCents: true, providerShareCents: true },
  });

  await prisma.auditLog.create({
    data: { actorId: params.actorUserId, action: "ACCESSORIAL_APPLIED", entityType: "BookingAccessorial", entityId: created.id, details: { accessorialTypeId: type.id, key: type.key, ...(params.booking.kind === "job" ? { jobId: params.booking.jobId } : { loadId: params.booking.loadId }), customerChargeCents: charge.customerChargeCents } },
  });

  return { ok: true as const, accessorial: created };
}

export function applyError(status: number, error: string) {
  return NextResponse.json({ error }, { status });
}
