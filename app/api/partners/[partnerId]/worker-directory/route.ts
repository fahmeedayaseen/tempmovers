import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { SAFE_WORKER_SELECT } from "@/lib/access/sanitize-worker";
import { resolvePartnerReadAccess } from "@/lib/partner-permissions";
import { workerDirectoryFilterSchema } from "@/lib/discovery/worker-directory-filter";
import { getWorkerMetricsBatch } from "@/lib/metrics/worker-metrics-db";
import { deriveAvailabilityBadge } from "@/lib/discovery/availability-badge";
import type { Prisma } from "@prisma/client";

/**
 * Worker directory — the SINGLE business-facing discovery endpoint
 * (Phase 1), extended in Phase 5 with advanced filtering, sorting, and
 * pagination. Still uses only SAFE_WORKER_SELECT fields; still scoped
 * to an approved partner's read access. No parallel search route was
 * created — this is THE directory.
 *
 * Filter/sort/paginate params are validated by the SHARED
 * workerDirectoryFilterSchema, the same one saved searches validate
 * against, so a saved search and a live search can never diverge.
 */
const DEFAULT_PAGE_SIZE = 20;

export async function GET(request: Request, context: { params: Promise<{ partnerId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["CUSTOMER", "ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { partnerId } = await context.params;
  const access = await resolvePartnerReadAccess(prisma, partnerId, authed);
  if (!access.allowed) return NextResponse.json({ error: access.reason }, { status: access.reason === "Partner not found." ? 404 : 403 });

  const { searchParams } = new URL(request.url);
  // Coerce query-string values into the shared schema's types (numbers,
  // booleans) before validating — the schema is the single contract.
  const raw = {
    query: searchParams.get("query") ?? undefined,
    workerType: searchParams.get("workerType") ?? undefined,
    marketId: searchParams.get("marketId") ?? undefined,
    skill: searchParams.get("skill") ?? undefined,
    languageCode: searchParams.get("languageCode") ?? undefined,
    minRating: searchParams.has("minRating") ? Number(searchParams.get("minRating")) : undefined,
    verifiedOnly: searchParams.has("verifiedOnly") ? searchParams.get("verifiedOnly") === "true" : undefined,
    acceptingJobsOnly: searchParams.has("acceptingJobsOnly") ? searchParams.get("acceptingJobsOnly") === "true" : undefined,
    availableFrom: searchParams.get("availableFrom") ?? undefined,
    availableTo: searchParams.get("availableTo") ?? undefined,
    sort: searchParams.get("sort") ?? undefined,
    sortDir: searchParams.get("sortDir") ?? undefined,
    page: searchParams.has("page") ? Number(searchParams.get("page")) : undefined,
    pageSize: searchParams.has("pageSize") ? Number(searchParams.get("pageSize")) : undefined,
  };
  const parsed = workerDirectoryFilterSchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const f = parsed.data;

  const where: Prisma.WorkerProfileWhereInput = {
    // Only genuinely eligible workers, exactly as before — a business
    // can't build a network from pending/suspended accounts.
    operationalStatus: "ACTIVE",
    workerType: f.workerType,
    displayName: f.query ? { contains: f.query, mode: "insensitive" } : undefined,
    workerMarkets: f.marketId ? { some: { marketId: f.marketId, active: true } } : undefined,
    skills: f.skill ? { some: { skill: { name: { equals: f.skill, mode: "insensitive" } } } } : undefined,
    languages: f.languageCode ? { some: { languageCode: f.languageCode } } : undefined,
    ratingAverage: f.minRating != null ? { gte: f.minRating } : undefined,
    // identityVerification's "verified" value is "APPROVED" (confirmed
    // against loads/request's existing check), NOT "VERIFIED".
    identityVerification: f.verifiedOnly ? "APPROVED" : undefined,
    acceptingJobs: f.acceptingJobsOnly ? true : undefined,
    // Availability-window filter: worker must have at least one
    // available window overlapping [from, to]. Only the existence is
    // used for filtering — the windows themselves are never returned.
    availability: f.availableFrom && f.availableTo
      ? { some: { isAvailable: true, startsAt: { lt: new Date(f.availableTo) }, endsAt: { gt: new Date(f.availableFrom) } } }
      : undefined,
  };

  // Sort — only over indexed/stored columns. responseTime is NOT a
  // stored column (it's derived), so it can't be an orderBy; when
  // requested, we fall back to a stable stored sort. rating/
  // completedJobs/recentlyActive are real columns.
  const dir = f.sortDir ?? "desc";
  let orderBy: Prisma.WorkerProfileOrderByWithRelationInput;
  switch (f.sort) {
    case "completedJobs": orderBy = { completedJobs: dir }; break;
    case "rating":
    case "responseTime": // derived metric, not a stored column — falls back to rating
    default: orderBy = { ratingAverage: dir };
  }

  const page = f.page ?? 1;
  const pageSize = f.pageSize ?? DEFAULT_PAGE_SIZE;

  const [total, workers] = await Promise.all([
    prisma.workerProfile.count({ where }),
    prisma.workerProfile.findMany({
      where,
      select: SAFE_WORKER_SELECT,
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  // Attach derived metrics (batch — one query for the page) and
  // availability badges. Badges need raw windows, fetched here and
  // collapsed immediately; the raw rows never enter the response.
  const ids = workers.map(w => w.id);
  const metricsByWorker = await getWorkerMetricsBatch(ids);
  const windows = ids.length
    ? await prisma.availability.findMany({ where: { workerId: { in: ids } }, select: { workerId: true, startsAt: true, endsAt: true, isAvailable: true } })
    : [];
  const windowsByWorker = new Map<string, { startsAt: Date; endsAt: Date; isAvailable: boolean }[]>();
  for (const w of windows) {
    const list = windowsByWorker.get(w.workerId) ?? [];
    list.push({ startsAt: w.startsAt, endsAt: w.endsAt, isAvailable: w.isAvailable });
    windowsByWorker.set(w.workerId, list);
  }

  const enriched = workers.map(w => ({
    ...w,
    metrics: metricsByWorker.get(w.id) ?? { completionRate: null, medianResponseMs: null },
    availabilityBadge: deriveAvailabilityBadge(windowsByWorker.get(w.id) ?? []),
  }));

  return NextResponse.json({
    workers: enriched,
    pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  });
}
