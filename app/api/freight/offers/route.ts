import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { assertFreightAllowed, FreightGateError } from "@/lib/freight/gate";
import { getCarrierEligibility } from "@/lib/carriers/eligibility-service";
import { isAssignable, type LoadStatus } from "@/lib/freight/load-lifecycle";

/**
 * Carrier offer creation / decline / withdrawal (P0-05). Acceptance is the
 * separate atomic /api/freight/offers/accept route. Offer creation captures an
 * eligibility snapshot and requires the load to be assignable. All audited.
 */
const ADMIN_ROLES = ["ADMIN", "FINANCE_ADMIN", "SUPER_ADMIN"] as const;

const createSchema = z.object({
  loadId: z.string().min(1),
  carrierId: z.string().min(1),
  offeredRateCents: z.number().int().nonnegative(),
  expiresAt: z.string().datetime(),
});

export async function POST(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ADMIN_ROLES as unknown as ("ADMIN")[]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const parsed = createSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const load = await prisma.freightLoad.findUnique({ where: { id: parsed.data.loadId } });
  if (!load) return NextResponse.json({ error: "Load not found." }, { status: 404 });

  try {
    await assertFreightAllowed({ capability: "carrierLoadAcceptance", userRole: authed.role, marketId: load.marketId, requireAdmin: true });
  } catch (e) {
    if (e instanceof FreightGateError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  if (!isAssignable(load.status as LoadStatus)) {
    return NextResponse.json({ error: `Load is ${load.status}; not open for offers.` }, { status: 409 });
  }

  // Capture an eligibility snapshot at offer time.
  const eligibility = await getCarrierEligibility(parsed.data.carrierId, "BROKER_LOAD_ASSIGNMENT", load.marketId);

  const offer = await prisma.$transaction(async (tx) => {
    const o = await tx.carrierOffer.create({
      data: {
        loadId: load.id, carrierId: parsed.data.carrierId, offeredRateCents: parsed.data.offeredRateCents,
        expiresAt: new Date(parsed.data.expiresAt), status: "PENDING", eligibilitySnapshot: eligibility,
      },
    });
    if (load.status === "AVAILABLE") await tx.freightLoad.update({ where: { id: load.id }, data: { status: "OFFERED" } });
    await tx.freightAuditEvent.create({ data: { loadId: load.id, event: "OFFER_CREATED", actorId: authed.userId, detail: { offerId: o.id, carrierId: o.carrierId } } });
    return o;
  });
  return NextResponse.json({ offer }, { status: 201 });
}

const actionSchema = z.object({ offerId: z.string().min(1), action: z.enum(["DECLINE", "WITHDRAW"]), reason: z.string().max(1000).optional() });

export async function PATCH(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["CARRIER", "ADMIN", "FINANCE_ADMIN", "SUPER_ADMIN"] as unknown as ("ADMIN")[]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const parsed = actionSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const offer = await prisma.carrierOffer.findUnique({ where: { id: parsed.data.offerId } });
  if (!offer) return NextResponse.json({ error: "Offer not found." }, { status: 404 });

  // DECLINE is the carrier's action (ownership required); WITHDRAW is admin's.
  if (parsed.data.action === "DECLINE" && !["ADMIN", "FINANCE_ADMIN", "SUPER_ADMIN"].includes(authed.role)) {
    const carrier = await prisma.carrier.findUnique({ where: { id: offer.carrierId }, select: { ownerUserId: true } });
    if (!carrier || carrier.ownerUserId !== authed.userId) return NextResponse.json({ error: "Not authorized." }, { status: 403 });
  }
  if (parsed.data.action === "WITHDRAW" && !["ADMIN", "FINANCE_ADMIN", "SUPER_ADMIN"].includes(authed.role)) {
    return NextResponse.json({ error: "Only an admin may withdraw an offer." }, { status: 403 });
  }

  if (!["PENDING", "VIEWED"].includes(offer.status)) {
    return NextResponse.json({ error: `Offer is ${offer.status}.` }, { status: 409 });
  }

  const newStatus = parsed.data.action === "DECLINE" ? "DECLINED" : "WITHDRAWN";
  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.carrierOffer.update({ where: { id: offer.id }, data: { status: newStatus, respondedAt: new Date(), declineReason: parsed.data.reason } });
    await tx.freightAuditEvent.create({ data: { loadId: offer.loadId, event: `OFFER_${newStatus}`, actorId: authed.userId, detail: { offerId: offer.id } } });
    return u;
  });
  return NextResponse.json({ offer: updated });
}
