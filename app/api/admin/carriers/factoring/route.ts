import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";

/**
 * Admin factoring verification (launch-required). An admin reviews a carrier's
 * factoring profile + Notice of Assignment and sets the verification status
 * with a date + verifier id. Verification is a point-in-time decision — an
 * expired/replaced NOA moves the profile back to EXPIRED and must be
 * re-verified.
 */
const ADMIN_ROLES = ["ADMIN", "SUPPORT", "FINANCE_ADMIN", "SUPER_ADMIN"] as const;

export async function GET(request: Request) {
  try {
    await requireRole(request, ADMIN_ROLES as unknown as ("ADMIN")[]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const profiles = await prisma.carrierFactoringProfile.findMany({
    where: status ? { verificationStatus: status as "PENDING_REVIEW" } : { verificationStatus: "PENDING_REVIEW" },
    include: { carrier: { select: { id: true, legalBusinessName: true, dotNumber: true, mcNumber: true } } },
    orderBy: { updatedAt: "desc" },
    take: 100,
  });
  return NextResponse.json({ profiles });
}

const decisionSchema = z.object({
  carrierId: z.string().min(1),
  decision: z.enum(["VERIFIED", "REJECTED", "EXPIRED"]),
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
  const parsed = decisionSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const { carrierId, decision, reason } = parsed.data;

  const profile = await prisma.carrierFactoringProfile.findUnique({ where: { carrierId } });
  if (!profile) return NextResponse.json({ error: "No factoring profile for this carrier." }, { status: 404 });

  const updated = await prisma.carrierFactoringProfile.update({
    where: { carrierId },
    data: {
      verificationStatus: decision,
      verifiedAt: decision === "VERIFIED" ? new Date() : null,
      verifiedById: decision === "VERIFIED" ? authed.userId : null,
    },
  });

  // Audit the verification decision against the carrier's payment routing.
  const active = await prisma.paymentAssignment.findFirst({ where: { carrierId, status: "ACTIVE" }, select: { id: true } });
  if (active) {
    await prisma.paymentRoutingAudit.create({
      data: { paymentAssignmentId: active.id, action: `FACTORING_${decision}`, reason, changedById: authed.userId },
    });
  }

  return NextResponse.json({ profile: updated });
}
