import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { SAFE_WORKER_SELECT } from "@/lib/access/sanitize-worker";
import { getWorkerMetrics } from "@/lib/metrics/worker-metrics-db";
import { deriveAvailabilityBadge } from "@/lib/discovery/availability-badge";
import { createDownloadUrl } from "@/lib/storage";

/**
 * A single worker's public profile card — the detail-view counterpart
 * to the worker directory's list results. Same SAFE_WORKER_SELECT
 * fields, plus recent review highlights: only PUBLISHED reviews, and
 * never the reviewing customer's identity — a profile card shows what
 * a worker has earned, not who said it.
 *
 * Any authenticated CUSTOMER or ADMIN can view a profile — unlike the
 * worker directory (which is scoped to a specific partner's search),
 * viewing one worker's own public card doesn't require owning a
 * partner organization, since this is the same kind of information a
 * customer would see attached to an assignment notice already.
 */
export async function GET(request: Request, context: { params: Promise<{ workerId: string }> }) {
  try {
    await requireRole(request, ["CUSTOMER", "ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { workerId } = await context.params;

  const worker = await prisma.workerProfile.findUnique({ where: { id: workerId }, select: SAFE_WORKER_SELECT });
  if (!worker) return NextResponse.json({ error: "Worker not found." }, { status: 404 });

  const reviews = await prisma.review.findMany({
    where: { workerId, status: "PUBLISHED" },
    select: { rating: true, comment: true, tags: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  // Phase 5: reliable derived metrics (completion rate, median response
  // time). On-time is intentionally not computed — no expected-arrival
  // field exists, so it's deferred rather than shipped as a proxy.
  const metrics = await getWorkerMetrics(workerId);

  // Phase 5: coarse availability BADGE only. The raw Availability rows
  // are fetched here but never returned — deriveAvailabilityBadge
  // collapses them to a single safe signal, so the exact calendar
  // (and anything location-adjacent) never leaves the server.
  const availabilityWindows = await prisma.availability.findMany({
    where: { workerId },
    select: { startsAt: true, endsAt: true, isAvailable: true },
  });
  const availabilityBadge = deriveAvailabilityBadge(availabilityWindows);

  // Phase 5.5A: approved portfolio preview for the card — count of
  // approved, visible media plus a signed thumbnail of the primary (or
  // most recent approved) item. Only APPROVED/non-deleted/non-removed
  // media is considered; the private key is used server-side to sign a
  // thumbnail URL and never returned raw.
  const approvedWhere = { workerId, status: "APPROVED" as const, deletedAt: null, removedAt: null };
  const [portfolioApprovedCount, primary] = await Promise.all([
    prisma.portfolioMedia.count({ where: approvedWhere }),
    prisma.portfolioMedia.findFirst({
      where: approvedWhere,
      orderBy: [{ isPrimary: "desc" }, { displayOrder: "asc" }, { approvedAt: "desc" }],
      select: { thumbnailKey: true, storageKey: true },
    }),
  ]);
  let portfolioPrimaryThumbnailUrl: string | null = null;
  if (primary) {
    try { portfolioPrimaryThumbnailUrl = await createDownloadUrl(primary.thumbnailKey ?? primary.storageKey); } catch { /* storage not configured */ }
  }

  return NextResponse.json({
    worker: { ...worker, portfolioApprovedCount, portfolioPrimaryThumbnailUrl },
    reviews, metrics, availabilityBadge,
  });
}
