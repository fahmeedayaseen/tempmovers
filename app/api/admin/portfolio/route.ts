import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { createDownloadUrl } from "@/lib/storage";
import type { Prisma } from "@prisma/client";

/**
 * Admin moderation queue (Phase 5.5). Lists media for review with status
 * filters, worker/category search, sort, and pagination. Admin/support
 * only. Returns moderation-relevant fields plus a signed preview URL and
 * the worker identity (admins legitimately see who submitted). Never
 * exposes raw storage keys.
 */
const DEFAULT_PAGE_SIZE = 20;
const querySchema = z.object({
  status: z.enum(["DRAFT", "UPLOADING", "PENDING", "APPROVED", "REJECTED", "REMOVED"]).optional(),
  reported: z.coerce.boolean().optional(),
  sort: z.enum(["newest", "oldest"]).default("newest"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(DEFAULT_PAGE_SIZE),
});

export async function GET(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["ADMIN", "SUPPORT"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  void authed;

  const { searchParams } = new URL(request.url);
  const parsed = querySchema.safeParse({
    status: searchParams.get("status") ?? undefined,
    reported: searchParams.get("reported") ?? undefined,
    sort: searchParams.get("sort") ?? undefined,
    page: searchParams.get("page") ?? undefined,
    pageSize: searchParams.get("pageSize") ?? undefined,
  });
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const f = parsed.data;

  const where: Prisma.PortfolioMediaWhereInput = {
    deletedAt: null,
    status: f.status,
    reports: f.reported ? { some: { status: { in: ["OPEN", "REVIEWING"] } } } : undefined,
  };

  const orderBy: Prisma.PortfolioMediaOrderByWithRelationInput = { submittedAt: f.sort === "newest" ? "desc" : "asc" };

  const [total, rows] = await Promise.all([
    prisma.portfolioMedia.count({ where }),
    prisma.portfolioMedia.findMany({
      where, orderBy, skip: (f.page - 1) * f.pageSize, take: f.pageSize,
      select: {
        id: true, title: true, description: true, status: true, mimeType: true, fileSize: true, width: true, height: true,
        submittedAt: true, createdAt: true, rejectionReason: true, moderationNote: true, storageKey: true, thumbnailKey: true,
        worker: { select: { id: true, displayName: true, workerType: true } },
        category: { select: { id: true, name: true } },
        _count: { select: { reports: true } },
      },
    }),
  ]);

  const media = await Promise.all(rows.map(async ({ storageKey, thumbnailKey, ...rest }) => {
    let previewUrl: string | null = null;
    try { previewUrl = await createDownloadUrl(thumbnailKey ?? storageKey); } catch { /* storage not configured */ }
    return { ...rest, previewUrl };
  }));

  return NextResponse.json({ media, pagination: { page: f.page, pageSize: f.pageSize, total, totalPages: Math.ceil(total / f.pageSize) } });
}
