import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { adminCanTransition, restoreTarget, canApproveGivenProcessing } from "@/lib/portfolio/state";
import type { PortfolioModerationStatus } from "@prisma/client";

/**
 * Shared implementation for the four admin moderation actions
 * (approve/reject/remove/restore). Each thin route file calls this with
 * its action. Centralizes: admin auth, existence check, legal-transition
 * gate (via the pure state machine), the status write with the right
 * audit timestamps/actor fields, and one audit event capturing
 * previous→new state. Rejection requires a worker-visible reason.
 */
export async function runModerationAction(
  request: Request,
  mediaId: string,
  action: "approve" | "reject" | "remove" | "restore",
) {
  let authed;
  try {
    authed = await requireRole(request, ["ADMIN", "SUPPORT"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const body = await request.json().catch(() => ({}));
  const media = await prisma.portfolioMedia.findUnique({ where: { id: mediaId } });
  if (!media || media.deletedAt) return NextResponse.json({ error: "Media not found." }, { status: 404 });

  if (!adminCanTransition(action, media.status)) {
    return NextResponse.json({ error: `Cannot ${action} an item in state ${media.status}.` }, { status: 409 });
  }

  // P0-02: approval additionally requires successful image processing.
  if ((action === "approve") && !canApproveGivenProcessing(media.processingStatus)) {
    return NextResponse.json({ error: `Cannot approve until image processing succeeds (processing: ${media.processingStatus}).` }, { status: 409 });
  }

  const now = new Date();
  let newStatus: PortfolioModerationStatus;
  const data: Record<string, unknown> = {};
  const note: string | undefined = typeof body?.moderationNote === "string" ? body.moderationNote : undefined;
  if (note !== undefined) data.moderationNote = note;

  if (action === "approve") {
    newStatus = "APPROVED";
    Object.assign(data, { status: newStatus, approvedAt: now, approvedById: authed.userId, rejectionReason: null, removedAt: null, removedById: null });
  } else if (action === "reject") {
    const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
    if (!reason) return NextResponse.json({ error: "A rejection reason is required." }, { status: 400 });
    newStatus = "REJECTED";
    Object.assign(data, { status: newStatus, rejectedAt: now, rejectedById: authed.userId, rejectionReason: reason });
  } else if (action === "remove") {
    newStatus = "REMOVED";
    // Removed approved media stops being publicly deliverable immediately
    // (isPubliclyVisible excludes removedAt != null), independent of when
    // its storage is physically cleaned.
    Object.assign(data, { status: newStatus, removedAt: now, removedById: authed.userId, isPrimary: false });
  } else {
    // restore — default to PENDING re-review unless explicitly to APPROVED
    newStatus = restoreTarget(body?.toApproved === true);
    Object.assign(data, { status: newStatus, removedAt: null, removedById: null, ...(newStatus === "APPROVED" ? { approvedAt: now, approvedById: authed.userId } : { submittedAt: now }) });
  }

  const updated = await prisma.portfolioMedia.update({ where: { id: media.id }, data, select: { id: true, status: true } });

  await prisma.auditLog.create({
    data: {
      actorId: authed.userId,
      action: `PORTFOLIO_${action.toUpperCase()}`,
      entityType: "PortfolioMedia",
      entityId: media.id,
      details: { workerId: media.workerId, previousState: media.status, newState: newStatus, reason: action === "reject" ? (body?.reason ?? null) : null },
    },
  });

  return NextResponse.json({ media: updated });
}
