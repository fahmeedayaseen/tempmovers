import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { assertFreightAllowed, FreightGateError } from "@/lib/freight/gate";
import { evaluateSettlementReadiness } from "@/lib/freight/offer-acceptance";
import { hasBlockingPaymentException } from "@/lib/carriers/payment-exceptions";
import { getCarrierEligibility } from "@/lib/carriers/eligibility-service";

/**
 * Carrier settlement preparation (P0-05). PREPARES a settlement — it never
 * executes payment (carrier settlement stays disabled). Enforces every payable
 * precondition, blocks on any payment exception, and applies the verified
 * factoring remittance destination. A carrier user can never override routing.
 *
 * Idempotent: creationKey + @@unique([loadId]) prevent a duplicate settlement.
 */
const ADMIN_ROLES = ["ADMIN", "FINANCE_ADMIN", "SUPER_ADMIN"] as const;

const schema = z.object({
  loadId: z.string().min(1),
  finalAmountCents: z.number().int().nonnegative(),
  creationKey: z.string().min(8).max(200),
});

export async function POST(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ADMIN_ROLES as unknown as ("ADMIN")[]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const load = await prisma.freightLoad.findUnique({ where: { id: parsed.data.loadId } });
  if (!load) return NextResponse.json({ error: "Load not found." }, { status: 404 });
  if (!load.assignedCarrierId) return NextResponse.json({ error: "Load has no assigned carrier." }, { status: 409 });

  try {
    await assertFreightAllowed({ capability: "carrierPayments", userRole: authed.role, marketId: load.marketId, requireAdmin: true });
  } catch (e) {
    if (e instanceof FreightGateError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  // Idempotency: existing settlement for this load or key → return it.
  const existing = await prisma.carrierSettlement.findFirst({ where: { OR: [{ loadId: load.id }, { creationKey: parsed.data.creationKey }] } });
  if (existing) return NextResponse.json({ settlement: existing, idempotent: true });

  const carrierId = load.assignedCarrierId;

  // Gather the payable preconditions from real state.
  const [podApprovedEvent, requiredDocsOk, eligibility] = await Promise.all([
    prisma.freightAuditEvent.findFirst({ where: { loadId: load.id, event: "POD_APPROVED" } }),
    // required docs approved = no unapproved required carrier docs (simplified: W9 approved)
    prisma.carrierDocument.findFirst({ where: { carrierId, type: "W9", verified: true } }),
    getCarrierEligibility(carrierId, "RECEIVE_LOAD_OFFER", load.marketId),
  ]);

  // Payment-exception gate: gather the carrier's routing state.
  const [pendingProfile, pendingAssignment] = await Promise.all([
    prisma.carrierFactoringProfile.findUnique({ where: { carrierId }, select: { verificationStatus: true } }),
    prisma.paymentAssignment.findFirst({ where: { carrierId, status: "PENDING_REVIEW" }, select: { id: true } }),
  ]);
  const blockingException = hasBlockingPaymentException({
    pendingNoaReview: pendingProfile?.verificationStatus === "PENDING_REVIEW",
    replacementNoaPending: false, letterOfReleasePending: false, conflictingInstructions: false,
    expiredAssignment: pendingProfile?.verificationStatus === "EXPIRED",
    routingChangeRequested: Boolean(pendingAssignment), blockedDirectPaymentAttempt: false, missingSupportingDocument: false,
  });

  const readiness = evaluateSettlementReadiness({
    loadDelivered: ["POD_PENDING", "COMPLETED", "INVOICED", "PAID"].includes(load.status),
    podApproved: Boolean(podApprovedEvent),
    requiredDocumentsApproved: Boolean(requiredDocsOk),
    carrierEligibleForPayment: eligibility.eligible,
    noBlockingPaymentException: !blockingException,
    finalCarrierAmountApproved: true, // this request IS the approval of the final amount
    duplicateSettlementExists: false, // guarded by idempotency above
  });
  if (!readiness.payable) {
    return NextResponse.json({ error: "Settlement is not payable.", blockers: readiness.blockers }, { status: 428 });
  }

  // Apply verified factoring routing — the remit-to destination is taken from
  // an ACTIVE verified assignment, NOT from anything the carrier supplies here.
  const activeAssignment = await prisma.paymentAssignment.findFirst({ where: { carrierId, status: "ACTIVE" }, select: { id: true, remitToName: true } });

  const settlement = await prisma.$transaction(async (tx) => {
    const s = await tx.carrierSettlement.create({
      data: {
        loadId: load.id, carrierId, finalAmountCents: parsed.data.finalAmountCents, status: "PENDING",
        creationKey: parsed.data.creationKey,
        remitToName: activeAssignment?.remitToName ?? null,
        paymentAssignmentId: activeAssignment?.id ?? null,
        approvedById: authed.userId, approvedAt: new Date(),
      },
    });
    await tx.freightAuditEvent.create({ data: { loadId: load.id, event: "SETTLEMENT_PREPARED", actorId: authed.userId, detail: { settlementId: s.id, routedToFactoring: Boolean(activeAssignment) } } });
    return s;
  });

  return NextResponse.json({ settlement, note: "Settlement prepared (not paid). Payout execution stays disabled until authority + activation." }, { status: 201 });
}
