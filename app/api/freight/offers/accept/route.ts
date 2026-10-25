import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { assertFreightAllowed, FreightGateError } from "@/lib/freight/gate";
import { evaluateOfferAcceptance } from "@/lib/freight/offer-acceptance";
import { getCarrierEligibility } from "@/lib/carriers/eligibility-service";
import { type LoadStatus } from "@/lib/freight/load-lifecycle";

/**
 * Accept a carrier offer — atomic, so two carriers cannot accept the same load.
 * DORMANT: gated by assertFreightAllowed (all brokerage flags OFF) so this is
 * inert until authority is confirmed and management enables the flags.
 *
 * Sequence (inside a Serializable transaction):
 *  1. Lock/read the load.  2. Confirm still assignable.  3. Recheck eligibility.
 *  4. Recheck brokerage+market gates.  5. Mark accepted offer.
 *  6. Expire competing offers.  7. Create assignment.  8. Write audit event.
 */
const schema = z.object({ offerId: z.string().min(1) });

export async function POST(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["CARRIER", "ADMIN", "SUPER_ADMIN"] as unknown as ("ADMIN")[]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const offer = await prisma.carrierOffer.findUnique({ where: { id: parsed.data.offerId }, include: { load: true } });
  if (!offer) return NextResponse.json({ error: "Offer not found." }, { status: 404 });

  // P0-04: ownership — a CARRIER user may only accept an offer made to their own
  // carrier. Admins may act on behalf of any. Ownership is Carrier.ownerUserId
  // (one owner per carrier in this schema; there is no CarrierMember model).
  if (!["ADMIN", "SUPER_ADMIN"].includes(authed.role)) {
    const carrier = await prisma.carrier.findUnique({ where: { id: offer.carrierId }, select: { ownerUserId: true } });
    if (!carrier || carrier.ownerUserId !== authed.userId) {
      return NextResponse.json({ error: "You are not authorized to accept this offer." }, { status: 403 });
    }
  }

  // Compliance gate (all five conditions; throws 403 while flags are off).
  try {
    await assertFreightAllowed({ capability: "carrierLoadAcceptance", userRole: authed.role, marketId: offer.load.marketId });
  } catch (e) {
    if (e instanceof FreightGateError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  // Recheck eligibility via the central service (no duplication here).
  const eligibility = await getCarrierEligibility(offer.carrierId, "BROKER_LOAD_ASSIGNMENT", offer.load.marketId);

  try {
    const result = await prisma.$transaction(async (tx) => {
      // 1. Re-read the load under the transaction.
      const load = await tx.freightLoad.findUnique({ where: { id: offer.loadId } });
      if (!load) throw new Error("LOAD_GONE");

      // 2-4. Evaluate the ordered guard sequence.
      const decision = evaluateOfferAcceptance({
        loadStatus: load.status as LoadStatus,
        offerStatus: offer.status,
        offerExpiresAt: offer.expiresAt.toISOString(),
        now: new Date(),
        carrierEligible: eligibility.eligible,
        brokerageGatesPass: true, // already asserted above
      });
      if (!decision.ok) return { conflict: decision };

      // 5. Mark the accepted offer.
      await tx.carrierOffer.update({ where: { id: offer.id }, data: { status: "ACCEPTED", respondedAt: new Date(), eligibilitySnapshot: eligibility } });
      // 6. Expire competing offers on the same load.
      await tx.carrierOffer.updateMany({ where: { loadId: offer.loadId, id: { not: offer.id }, status: { in: ["PENDING", "VIEWED"] } }, data: { status: "SUPERSEDED" } });
      // 7. Assign the load (status ACCEPTED, carrier set) — conditional update
      //    guards against a concurrent accept: only flips if still assignable.
      const assigned = await tx.freightLoad.updateMany({
        where: { id: load.id, status: { in: ["AVAILABLE", "OFFERED"] } },
        data: { status: "ACCEPTED", assignedCarrierId: offer.carrierId },
      });
      if (assigned.count !== 1) throw new Error("RACE_LOST"); // someone else accepted first
      // 8. Audit.
      await tx.freightAuditEvent.create({ data: { loadId: load.id, event: "OFFER_ACCEPTED", actorId: authed.userId, detail: { offerId: offer.id, carrierId: offer.carrierId } } });

      return { ok: true };
    }, { isolationLevel: "Serializable" });

    // VASRUE Digital Media — BLOCK-05, 24 Oct 2026. The `in` operator does not
    // narrow a union whose members carry `conflict?: undefined`, so result.conflict
    // stayed possibly-undefined. A truthiness check narrows it correctly.
    if (result.conflict) return NextResponse.json({ error: result.conflict.message, code: result.conflict.code }, { status: 409 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "error";
    if (msg === "RACE_LOST" || msg === "LOAD_GONE") return NextResponse.json({ error: "Load was already assigned.", code: "RACE_LOST" }, { status: 409 });
    throw e;
  }
}
