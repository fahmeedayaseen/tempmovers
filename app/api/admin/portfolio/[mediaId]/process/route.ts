import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { imageProcessingEnabled } from "@/lib/portfolio/feature-flags";
import { processPortfolioImage } from "@/lib/portfolio/image-processing";

/**
 * Phase 5.5B manual processing trigger (admin retry).
 *
 * ⚠️ CODE COMPLETE / VALIDATION PENDING — runs sharp against a real object.
 *
 * Runs the processing pass for one item and persists the result. Guarded by
 * the PORTFOLIO_IMAGE_PROCESSING flag (503 when off, so it never pretends to
 * process). P1 fix: only valid processing states may be (re)processed —
 * PENDING (not yet picked up) or FAILED (explicit retry). PROCESSED / already
 * PROCESSING items are rejected so a manual call can't double-process or
 * clobber an in-flight run.
 */
const REPROCESSABLE = ["PENDING", "FAILED"];

export async function POST(request: Request, context: { params: Promise<{ mediaId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["ADMIN", "SUPPORT"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { mediaId } = await context.params;

  if (!imageProcessingEnabled()) {
    return NextResponse.json({ error: "Image processing is not enabled in this environment (Phase 5.5B pending validation)." }, { status: 503 });
  }

  const media = await prisma.portfolioMedia.findUnique({ where: { id: mediaId } });
  if (!media || media.deletedAt) return NextResponse.json({ error: "Media not found." }, { status: 404 });
  if (!REPROCESSABLE.includes(media.processingStatus)) {
    return NextResponse.json({ error: `Cannot process an item whose processing status is ${media.processingStatus}.` }, { status: 409 });
  }

  // Atomic claim so a manual trigger and the background worker can't both run.
  const claim = await prisma.portfolioMedia.updateMany({
    where: { id: media.id, processingStatus: { in: REPROCESSABLE } },
    data: { processingStatus: "PROCESSING" },
  });
  if (claim.count === 0) return NextResponse.json({ error: "Item is already being processed." }, { status: 409 });

  const result = await processPortfolioImage({ storageKey: media.storageKey, declaredMime: media.mimeType });

  if (!result.ok) {
    const safetyFailure = /match an accepted image type|decompression|decoded|pixel|size is outside|no longer exists/i.test(result.reason);
    await prisma.portfolioMedia.update({
      where: { id: media.id },
      data: safetyFailure
        ? { processingStatus: "FAILED", processingError: result.reason, status: "REJECTED", rejectionReason: "This image did not pass automated safety checks.", deletedAt: new Date() }
        : { processingStatus: "FAILED", processingError: result.reason },
    });
    await prisma.auditLog.create({ data: { actorId: authed.userId, action: "PORTFOLIO_PROCESS_FAILED", entityType: "PortfolioMedia", entityId: media.id, details: { reason: result.reason, safetyFailure } } });
    return NextResponse.json({ processed: false, reason: result.reason }, { status: 422 });
  }

  const updated = await prisma.portfolioMedia.update({
    where: { id: media.id },
    data: { processingStatus: "PROCESSED", width: result.width, height: result.height, thumbnailKey: result.thumbnailKey, processingError: null },
    select: { id: true, processingStatus: true, width: true, height: true },
  });
  await prisma.auditLog.create({ data: { actorId: authed.userId, action: "PORTFOLIO_PROCESSED", entityType: "PortfolioMedia", entityId: media.id, details: { thumbnail: Boolean(result.thumbnailKey) } } });

  return NextResponse.json({ processed: true, media: updated });
}
