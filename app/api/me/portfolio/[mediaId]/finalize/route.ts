import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { headObject, StorageNotConfiguredError } from "@/lib/storage";
import { isAllowedMime, PORTFOLIO_MAX_BYTES } from "@/lib/portfolio/validation";
import { imageProcessingEnabled } from "@/lib/portfolio/feature-flags";

/**
 * Finalize a portfolio upload (Phase 5.5A). After the client PUTs bytes
 * to S3, this confirms the object is real and sane, then moves the
 * record into the moderation queue. Per the 5.5A/5.5B split, the gate
 * here is deliberately limited to checks that use ONLY existing,
 * reusable infrastructure (HeadObject) — no byte-fetching, no image
 * decoding:
 *
 *   1. the authenticated worker owns the draft,
 *   2. the record is in the expected DRAFT/UPLOADING state,
 *   3. HeadObject confirms the object EXISTS,
 *   4. the object's recorded size is within limits and consistent with
 *      the draft metadata,
 *   5. the declared content type is allowed at the 5.5A level,
 *   6. only then → PENDING, written transactionally with its audit event.
 *
 * Magic-byte/signature validation, EXIF stripping, dimension and
 * decompression-bomb checks, and thumbnail generation are Phase 5.5B:
 * they require reading/decoding the real object and cannot be verified
 * here, so they are intentionally NOT part of this gate. See
 * lib/portfolio/validation.ts (signatureMatchesMime/validateDimensions)
 * and PHASE-5.5 docs — those are scaffolded but not wired in until 5.5B.
 */
export async function POST(request: Request, context: { params: Promise<{ mediaId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["MOVER", "DRIVER"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { mediaId } = await context.params;

  const worker = await prisma.workerProfile.findUnique({ where: { userId: authed.userId }, select: { id: true } });
  if (!worker) return NextResponse.json({ error: "Worker profile not found." }, { status: 404 });

  const media = await prisma.portfolioMedia.findUnique({ where: { id: mediaId } });
  if (!media || media.deletedAt || media.workerId !== worker.id) {
    return NextResponse.json({ error: "Media not found." }, { status: 404 });
  }
  if (media.status !== "UPLOADING" && media.status !== "DRAFT") {
    return NextResponse.json({ error: "This item has already been submitted." }, { status: 409 });
  }
  if (!isAllowedMime(media.mimeType)) {
    return NextResponse.json({ error: "Unsupported image type." }, { status: 400 });
  }

  // HeadObject: confirm the object exists and read its server-recorded
  // size. A client cannot register a phantom object or one that never
  // actually landed in the bucket.
  let head;
  try {
    head = await headObject(media.storageKey);
  } catch (e) {
    if (e instanceof StorageNotConfiguredError) return NextResponse.json({ error: e.message }, { status: 500 });
    throw e;
  }
  if (!head) return NextResponse.json({ error: "Uploaded file was not found in storage." }, { status: 409 });
  if (head.contentLength <= 0 || head.contentLength > PORTFOLIO_MAX_BYTES) {
    return NextResponse.json({ error: "Uploaded file size is invalid." }, { status: 400 });
  }
  // Consistency: the object's recorded content type, when present, must
  // match the declared draft MIME. (A full magic-byte check is 5.5B.)
  if (head.contentType && head.contentType !== media.mimeType) {
    return NextResponse.json({ error: "Uploaded file type does not match the requested type." }, { status: 400 });
  }

  // Optional dimensions the client measured — stored if provided, but NOT
  // validated as a security gate here (dimension/bomb checks are 5.5B).
  const body = await request.json().catch(() => ({}));
  const width = typeof body?.width === "number" ? body.width : media.width;
  const height = typeof body?.height === "number" ? body.height : media.height;

  // State transition + audit written transactionally. P0-03: processing is
  // NOT fired from the request. Instead we record the processing intent on
  // the row (PENDING when the feature is on, NOT_REQUIRED when off) and let
  // a durable background worker (scripts/portfolio-process.ts, wired to a
  // real queue/cron in infra work) claim and process it. This removes any
  // reliance on request lifetime for image processing.
  const processingStatus = imageProcessingEnabled() ? "PENDING" : "NOT_REQUIRED";
  const [updated] = await prisma.$transaction([
    prisma.portfolioMedia.update({
      where: { id: media.id },
      data: { status: "PENDING", processingStatus, uploadedAt: new Date(), submittedAt: new Date(), fileSize: head.contentLength, width, height },
      select: { id: true, status: true, processingStatus: true, submittedAt: true },
    }),
    prisma.auditLog.create({
      data: { actorId: authed.userId, action: "PORTFOLIO_FINALIZE", entityType: "PortfolioMedia", entityId: media.id, details: { workerId: worker.id, previousState: media.status, newState: "PENDING", processingStatus } },
    }),
  ]);

  return NextResponse.json({ media: updated });
}
