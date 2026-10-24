import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { OWNER_PORTFOLIO_MEDIA_SELECT } from "@/lib/portfolio/public-select";
import { validatePresign, extensionForMime, isAllowedMime } from "@/lib/portfolio/validation";
import { buildPortfolioKey, createPortfolioUploadUrl, StorageNotConfiguredError } from "@/lib/storage";

/**
 * Owner portfolio (Phase 5.5). GET returns the worker's own media
 * INCLUDING private moderation states (pending/rejected), via
 * OWNER_PORTFOLIO_MEDIA_SELECT — still no raw storage keys. POST is the
 * presign step: validate ownership/eligibility/metadata/limits, mint a
 * short-lived upload URL, and create a DRAFT PortfolioMedia row holding
 * the private storageKey. The client uploads to S3 directly, then calls
 * finalize. Mirrors the existing uploads/presign pattern (presign here,
 * a separate confirm step persists the "real" state).
 */
const presignSchema = z.object({
  mimeType: z.string(),
  contentLength: z.number().int().positive(),
  title: z.string().max(120).optional(),
});

async function ownerWorker(userId: string) {
  return prisma.workerProfile.findUnique({ where: { userId }, select: { id: true } });
}

export async function GET(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["MOVER", "DRIVER"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const worker = await ownerWorker(authed.userId);
  if (!worker) return NextResponse.json({ error: "Worker profile not found." }, { status: 404 });

  const media = await prisma.portfolioMedia.findMany({
    where: { workerId: worker.id, deletedAt: null },
    orderBy: [{ displayOrder: "asc" }, { createdAt: "desc" }],
    select: OWNER_PORTFOLIO_MEDIA_SELECT,
  });
  return NextResponse.json({ media });
}

export async function POST(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["MOVER", "DRIVER"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const worker = await ownerWorker(authed.userId);
  if (!worker) return NextResponse.json({ error: "Worker profile not found." }, { status: 404 });

  const parsed = presignSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const activeCount = await prisma.portfolioMedia.count({ where: { workerId: worker.id, deletedAt: null } });
  const check = validatePresign({ mimeType: parsed.data.mimeType, contentLength: parsed.data.contentLength, currentActiveCount: activeCount });
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });
  if (!isAllowedMime(parsed.data.mimeType)) return NextResponse.json({ error: "Unsupported image type." }, { status: 400 });

  const key = buildPortfolioKey({ workerId: worker.id, fileExtension: extensionForMime(parsed.data.mimeType) });

  let uploadUrl: string;
  try {
    uploadUrl = await createPortfolioUploadUrl({ key, contentType: parsed.data.mimeType, contentLength: parsed.data.contentLength });
  } catch (e) {
    if (e instanceof StorageNotConfiguredError) return NextResponse.json({ error: e.message }, { status: 500 });
    if (e instanceof Error) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }

  const media = await prisma.portfolioMedia.create({
    data: {
      workerId: worker.id,
      status: "UPLOADING",
      storageKey: key,
      mimeType: parsed.data.mimeType,
      fileSize: parsed.data.contentLength,
      title: parsed.data.title ?? null,
    },
    select: { id: true, status: true },
  });

  await prisma.auditLog.create({
    data: { actorId: authed.userId, action: "PORTFOLIO_PRESIGN", entityType: "PortfolioMedia", entityId: media.id, details: { workerId: worker.id, mimeType: parsed.data.mimeType } },
  });

  return NextResponse.json({ mediaId: media.id, uploadUrl, key }, { status: 201 });
}
