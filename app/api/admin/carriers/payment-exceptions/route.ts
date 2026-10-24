import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { classifyPaymentExceptions } from "@/lib/carriers/payment-exceptions";

/**
 * Admin factoring payment-exception queue (launch spec §6). Aggregates the
 * unresolved payment-routing situations that must be cleared before automated
 * payout. Read-only view; resolution happens through the factoring/routing
 * admin endpoints. No unresolved exception may reach payout — the payout
 * service calls hasBlockingPaymentException() for the same carrier.
 */
const ADMIN_ROLES = ["ADMIN", "SUPPORT", "FINANCE_ADMIN", "SUPER_ADMIN"] as const;

export async function GET(request: Request) {
  try {
    await requireRole(request, ADMIN_ROLES as unknown as ("ADMIN")[]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  // Carriers with any potentially-exceptional payment/factoring state.
  const [pendingProfiles, pendingAssignments, recentBlockedAttempts] = await Promise.all([
    prisma.carrierFactoringProfile.findMany({ where: { verificationStatus: { in: ["PENDING_REVIEW", "EXPIRED"] } }, include: { carrier: { select: { id: true, legalBusinessName: true } } } }),
    prisma.paymentAssignment.findMany({ where: { status: "PENDING_REVIEW" }, include: { carrier: { select: { id: true, legalBusinessName: true } } } }),
    prisma.paymentRoutingAudit.findMany({ where: { action: "CHANGE_REQUESTED" }, orderBy: { createdAt: "desc" }, take: 100 }),
  ]);

  // Build a per-carrier exception summary.
  const byCarrier = new Map<string, { carrierId: string; carrierName: string; exceptions: { code: string; message: string }[] }>();
  const add = (carrierId: string, carrierName: string, input: Parameters<typeof classifyPaymentExceptions>[0]) => {
    const existing = byCarrier.get(carrierId) ?? { carrierId, carrierName, exceptions: [] };
    existing.exceptions.push(...classifyPaymentExceptions(input));
    byCarrier.set(carrierId, existing);
  };

  const blank = { pendingNoaReview: false, replacementNoaPending: false, letterOfReleasePending: false, conflictingInstructions: false, expiredAssignment: false, routingChangeRequested: false, blockedDirectPaymentAttempt: false, missingSupportingDocument: false };

  for (const p of pendingProfiles) add(p.carrier.id, p.carrier.legalBusinessName, { ...blank, pendingNoaReview: p.verificationStatus === "PENDING_REVIEW", expiredAssignment: p.verificationStatus === "EXPIRED" });
  for (const a of pendingAssignments) add(a.carrier.id, a.carrier.legalBusinessName, { ...blank, routingChangeRequested: true });
  const blockedCarrierIds = new Set(recentBlockedAttempts.map((a) => a.paymentAssignmentId));

  return NextResponse.json({
    queue: Array.from(byCarrier.values()).filter((c) => c.exceptions.length > 0),
    blockedAttemptCount: blockedCarrierIds.size,
    note: "No carrier with unresolved exceptions may reach automated payout.",
  });
}
