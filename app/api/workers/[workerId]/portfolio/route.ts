import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { PUBLIC_PORTFOLIO_MEDIA_SELECT } from "@/lib/portfolio/public-select";
import { createDownloadUrl } from "@/lib/storage";

/**
 * Public portfolio gallery (Phase 5.5). Returns ONLY approved, non-
 * deleted, non-removed media, via PUBLIC_PORTFOLIO_MEDIA_SELECT (which
 * omits every private column). Delivery/thumbnail URLs are short-lived
 * signed GETs resolved here from the private keys — the raw keys never
 * reach the client. Paginated. No auth required (it's public), but only
 * public-safe fields are ever returned.
 *
 * NOTE: the select can't itself expose storageKey/thumbnailKey, so we
 * fetch those two keys in a SEPARATE minimal query keyed by the already-
 * approved ids, sign them, and merge — the public rows and the private
 * keys never travel together in one selectable object handed to the
 * client.
 */
const DEFAULT_PAGE_SIZE = 24;

export async function GET(request: Request, context: { params: Promise<{ workerId: string }> }) {
  const { workerId } = await context.params;
  const { searchParams } = new URL(request.url);
  const paged = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(48).default(DEFAULT_PAGE_SIZE) })
    .safeParse({ page: searchParams.get("page") ?? undefined, pageSize: searchParams.get("pageSize") ?? undefined });
  const page = paged.success ? paged.data.page : 1;
  const pageSize = paged.success ? paged.data.pageSize : DEFAULT_PAGE_SIZE;

  const where = { workerId, status: "APPROVED" as const, deletedAt: null, removedAt: null };

  const [total, rows, keyRows] = await Promise.all([
    prisma.portfolioMedia.count({ where }),
    prisma.portfolioMedia.findMany({ where, orderBy: [{ isPrimary: "desc" }, { displayOrder: "asc" }, { approvedAt: "desc" }], skip: (page - 1) * pageSize, take: pageSize, select: PUBLIC_PORTFOLIO_MEDIA_SELECT }),
    prisma.portfolioMedia.findMany({ where, orderBy: [{ isPrimary: "desc" }, { displayOrder: "asc" }, { approvedAt: "desc" }], skip: (page - 1) * pageSize, take: pageSize, select: { id: true, storageKey: true, thumbnailKey: true } }),
  ]);

  const keyById = new Map(keyRows.map(k => [k.id, k]));
  const media = await Promise.all(rows.map(async (row) => {
    const keys = keyById.get(row.id);
    let deliveryUrl: string | null = null;
    let thumbnailUrl: string | null = null;
    try {
      if (keys?.storageKey) deliveryUrl = await createDownloadUrl(keys.storageKey);
      if (keys?.thumbnailKey) thumbnailUrl = await createDownloadUrl(keys.thumbnailKey);
    } catch {
      // Storage not configured or signing failed — return the record
      // without a URL rather than 500 the whole gallery.
    }
    return { ...row, deliveryUrl, thumbnailUrl };
  }));

  return NextResponse.json({ media, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } });
}
