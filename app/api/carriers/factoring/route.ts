import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { evaluateRemittanceChange, type ActiveAssignmentView } from "@/lib/carriers/payment-routing";

/**
 * Carrier factoring profile (self-service) + remittance-destination changes.
 *
 * The factoring PROFILE (whether they factor, company name/contact/reference)
 * is carrier-editable. The remittance DESTINATION is controlled: when an
 * active verified Notice of Assignment exists, a carrier cannot change where
 * funds are remitted — it routes to admin review. Every attempt writes a
 * PaymentRoutingAudit row.
 *
 * No bank-account credentials are accepted or stored (banking stays with the
 * payment provider).
 */
const profileSchema = z.object({
  usesFactoring: z.boolean(),
  factoringCompanyName: z.string().max(200).optional(),
  contactName: z.string().max(200).optional(),
  contactEmail: z.string().email().optional(),
  contactPhone: z.string().max(40).optional(),
  accountReference: z.string().max(120).optional(),
  factoringPartnerId: z.string().optional(),
});

async function carrierForUser(userId: string) {
  return prisma.carrier.findUnique({ where: { ownerUserId: userId } });
}

export async function GET(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["CARRIER", "ADMIN", "SUPPORT", "FINANCE_ADMIN", "SUPER_ADMIN"] as unknown as ("ADMIN")[]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const carrier = await carrierForUser(authed.userId);
  if (!carrier) return NextResponse.json({ error: "No carrier profile." }, { status: 404 });
  const profile = await prisma.carrierFactoringProfile.findUnique({ where: { carrierId: carrier.id } });
  const activeAssignment = await prisma.paymentAssignment.findFirst({ where: { carrierId: carrier.id, status: "ACTIVE" } });
  return NextResponse.json({ profile, activeAssignment });
}

export async function POST(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["CARRIER", "ADMIN", "SUPER_ADMIN"] as unknown as ("ADMIN")[]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const parsed = profileSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const carrier = await carrierForUser(authed.userId);
  if (!carrier) return NextResponse.json({ error: "No carrier profile." }, { status: 404 });

  // Editing the factoring profile resets verification to pending (any change to
  // factoring details must be re-verified by an admin).
  const profile = await prisma.carrierFactoringProfile.upsert({
    where: { carrierId: carrier.id },
    create: { carrierId: carrier.id, ...parsed.data, verificationStatus: "PENDING_REVIEW" },
    update: { ...parsed.data, verificationStatus: "PENDING_REVIEW", verifiedAt: null, verifiedById: null },
  });
  return NextResponse.json({ profile });
}

// Request a remittance-destination change. Subject to the NOA change-control.
const remittanceSchema = z.object({
  remitToName: z.string().min(1).max(200),
  remitToReference: z.string().max(120).optional(),
  remittanceInstructions: z.string().max(2000).optional(),
  supportingDocumentId: z.string().optional(),
  reason: z.string().max(1000).optional(),
});

export async function PATCH(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["CARRIER", "ADMIN", "FINANCE_ADMIN", "SUPER_ADMIN"] as unknown as ("ADMIN")[]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const parsed = remittanceSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const carrier = await carrierForUser(authed.userId);
  if (!carrier) return NextResponse.json({ error: "No carrier profile." }, { status: 404 });

  const active = await prisma.paymentAssignment.findFirst({ where: { carrierId: carrier.id, status: "ACTIVE" }, select: { id: true, status: true, remitToName: true, noaDocumentId: true } });
  let noaVerified = false;
  if (active?.noaDocumentId) {
    // NOA is "verified" if its factoring profile is VERIFIED (admin-verified).
    const prof = await prisma.carrierFactoringProfile.findUnique({ where: { carrierId: carrier.id }, select: { verificationStatus: true } });
    noaVerified = prof?.verificationStatus === "VERIFIED";
  }
  const activeView: ActiveAssignmentView | null = active ? { status: active.status as ActiveAssignmentView["status"], noaVerified } : null;

  const isAdmin = ["ADMIN", "FINANCE_ADMIN", "SUPER_ADMIN"].includes(authed.role);
  const decision = evaluateRemittanceChange(activeView, { actorIsAdmin: isAdmin, hasSupportingDocument: Boolean(parsed.data.supportingDocumentId), reason: parsed.data.reason });

  // Always audit the attempt.
  await prisma.$transaction(async (tx) => {
    if (decision.allowed) {
      // Supersede the old assignment, create the new ACTIVE one.
      if (active) await tx.paymentAssignment.update({ where: { id: active.id }, data: { status: "SUPERSEDED" } });
      const created = await tx.paymentAssignment.create({
        data: {
          carrierId: carrier.id,
          remitToName: parsed.data.remitToName,
          remitToReference: parsed.data.remitToReference,
          remittanceInstructions: parsed.data.remittanceInstructions,
          noaDocumentId: parsed.data.supportingDocumentId,
          status: isAdmin ? "ACTIVE" : "PENDING_REVIEW",
          approvedById: isAdmin ? authed.userId : null,
          approvedAt: isAdmin ? new Date() : null,
          effectiveAt: isAdmin ? new Date() : null,
        },
      });
      await tx.paymentRoutingAudit.create({
        data: { paymentAssignmentId: created.id, action: isAdmin ? "APPROVED" : "CREATED", previousRemitTo: active?.remitToName ?? null, newRemitTo: parsed.data.remitToName, supportingDocumentId: parsed.data.supportingDocumentId, reason: parsed.data.reason, changedById: authed.userId },
      });
    } else if (active) {
      // Blocked change still audited as a change request against the active row.
      await tx.paymentRoutingAudit.create({
        data: { paymentAssignmentId: active.id, action: "CHANGE_REQUESTED", previousRemitTo: active.remitToName, newRemitTo: parsed.data.remitToName, supportingDocumentId: parsed.data.supportingDocumentId, reason: parsed.data.reason, changedById: authed.userId },
      });
    }
  });

  if (!decision.allowed) {
    return NextResponse.json({ error: decision.reason, requiresAdminReview: true }, { status: 428 });
  }
  return NextResponse.json({ ok: true, appliedImmediately: isAdmin });
}
