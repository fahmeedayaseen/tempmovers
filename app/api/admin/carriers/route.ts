import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { canTransition, evaluateLoadEligibility, type CarrierStatus, type InsurancePolicyView } from "@/lib/carriers/lifecycle";

/**
 * Admin carrier review + status transitions (launch spec phase 3).
 *  - GET  ?status=UNDER_REVIEW : review queue.
 *  - PATCH: transition a carrier's status through the VALIDATED state machine
 *    (canTransition), writing a CarrierStatusEvent audit row every time.
 *
 * Guardrails:
 *  - Illegal transitions (e.g. APPLICATION_STARTED -> ACTIVE) are rejected 409.
 *  - Moving a carrier to ACTIVE additionally requires load-eligibility to hold
 *    (ACTIVE + required insurance present/unexpired) — so an admin can't mark a
 *    carrier ACTIVE while its insurance is missing/expired.
 *  - Every change is audited with actor + reason.
 */
const ADMIN_ROLES = ["ADMIN", "SUPPORT", "FINANCE_ADMIN", "SUPER_ADMIN"] as const;
const REQUIRED_INSURANCE: InsurancePolicyView["type"][] = ["AUTO_LIABILITY", "CARGO"];

export async function GET(request: Request) {
  try {
    await requireRole(request, ADMIN_ROLES as unknown as ("ADMIN")[]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const url = new URL(request.url);
  const status = url.searchParams.get("status") as CarrierStatus | null;
  const carriers = await prisma.carrier.findMany({
    where: status ? { status } : undefined,
    include: { insurancePolicies: true, fmcsaChecks: { orderBy: { checkedAt: "desc" }, take: 1 } },
    orderBy: { updatedAt: "desc" },
    take: 100,
  });
  return NextResponse.json({ carriers });
}

const patchSchema = z.object({
  carrierId: z.string().min(1),
  toStatus: z.enum(["APPLICATION_STARTED", "DOCUMENTS_PENDING", "UNDER_REVIEW", "APPROVED", "ACTIVE", "TEMPORARILY_INACTIVE", "SUSPENDED", "REJECTED", "EXPIRED_DOCUMENTS"]),
  reason: z.string().max(1000).optional(),
});

export async function PATCH(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ADMIN_ROLES as unknown as ("ADMIN")[]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const parsed = patchSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const { carrierId, toStatus, reason } = parsed.data;

  const carrier = await prisma.carrier.findUnique({ where: { id: carrierId }, include: { insurancePolicies: true } });
  if (!carrier) return NextResponse.json({ error: "Carrier not found." }, { status: 404 });

  const from = carrier.status as CarrierStatus;
  if (!canTransition(from, toStatus)) {
    return NextResponse.json({ error: `Illegal status transition: ${from} -> ${toStatus}.` }, { status: 409 });
  }

  // Extra guard: activating requires load-eligibility (insurance valid now).
  if (toStatus === "ACTIVE") {
    const policies: InsurancePolicyView[] = carrier.insurancePolicies.map((p) => ({ type: p.type as InsurancePolicyView["type"], expiresAt: p.expiresAt ? p.expiresAt.toISOString() : null }));
    const elig = evaluateLoadEligibility({ status: "ACTIVE", policies, now: new Date(), requiredInsurance: REQUIRED_INSURANCE });
    if (!elig.eligible) {
      return NextResponse.json({ error: "Cannot activate carrier.", reasons: elig.reasons }, { status: 428 });
    }
  }

  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.carrier.update({
      where: { id: carrierId },
      data: {
        status: toStatus,
        statusReason: reason,
        approvedAt: toStatus === "APPROVED" ? new Date() : carrier.approvedAt,
        activatedAt: toStatus === "ACTIVE" ? new Date() : carrier.activatedAt,
      },
    });
    await tx.carrierStatusEvent.create({
      data: { carrierId, fromStatus: from, toStatus, reason, changedById: authed.userId },
    });
    return u;
  });

  return NextResponse.json({ carrier: updated });
}
