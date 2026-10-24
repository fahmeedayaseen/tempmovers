import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import type { Prisma } from "@prisma/client";

/**
 * Admin report queue (Phase 5.5A). Lists portfolio reports with status
 * filter, sort, and pagination for moderator review. Admin/support only.
 * Includes the reported media's moderation-relevant fields and the
 * reporting user id (admins legitimately see reporters); this is not a
 * public endpoint, so reporter identity here is fine — it must never
 * appear in any PUBLIC response.
 */
const DEFAULT_PAGE_SIZE = 20;
const querySchema = z.object({
  status: z.enum(["OPEN", "REVIEWING", "RESOLVED", "DISMISSED"]).optional(),
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
    sort: searchParams.get("sort") ?? undefined,
    page: searchParams.get("page") ?? undefined,
    pageSize: searchParams.get("pageSize") ?? undefined,
  });
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const f = parsed.data;

  const where: Prisma.PortfolioReportWhereInput = { status: f.status };
  const [total, reports] = await Promise.all([
    prisma.portfolioReport.count({ where }),
    prisma.portfolioReport.findMany({
      where,
      orderBy: { createdAt: f.sort === "newest" ? "desc" : "asc" },
      skip: (f.page - 1) * f.pageSize,
      take: f.pageSize,
      select: {
        id: true, reason: true, details: true, status: true, createdAt: true, reviewedAt: true, resolutionNote: true, reporterUserId: true,
        media: { select: { id: true, title: true, status: true, worker: { select: { id: true, displayName: true } } } },
      },
    }),
  ]);

  return NextResponse.json({ reports, pagination: { page: f.page, pageSize: f.pageSize, total, totalPages: Math.ceil(total / f.pageSize) } });
}
