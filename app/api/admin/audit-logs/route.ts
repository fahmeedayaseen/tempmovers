import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";

/**
 * Real cursor-based pagination, added after a review correctly noted
 * this only ever returned the first `limit` (max 200) rows — for a
 * growing production audit table, that's not "pagination," it's a
 * hard ceiling with no way to see anything beyond it. Cursor is the
 * last-seen log's own `id`, paired with `createdAt desc` ordering —
 * standard Prisma cursor pagination, stable even as new rows are
 * written concurrently (unlike an offset, which would skip or repeat
 * rows if the table changes between page requests).
 */
export async function GET(request: Request) {
  try {
    await requireRole(request, ["ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { searchParams } = new URL(request.url);
  const entityType = searchParams.get("entityType") || undefined;
  const entityId = searchParams.get("entityId") || undefined;
  const action = searchParams.get("action") || undefined;
  const cursor = searchParams.get("cursor") || undefined;
  const limit = Math.min(200, Math.max(1, Number(searchParams.get("limit") ?? 50) || 50));

  const logs = await prisma.auditLog.findMany({
    where: { entityType, entityId, action },
    orderBy: { createdAt: "desc" },
    take: limit + 1, // fetch one extra to know if there's a next page, without a separate count query
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: { actor: { select: { id: true, email: true, role: true } } },
  });

  const hasMore = logs.length > limit;
  const page = hasMore ? logs.slice(0, limit) : logs;
  const nextCursor = hasMore ? page[page.length - 1].id : null;

  return NextResponse.json({ logs: page, nextCursor, hasMore });
}
