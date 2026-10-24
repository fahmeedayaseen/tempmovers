import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";

/**
 * Remove a favorite (Phase 5). Keyed by workerId (not the favorite row
 * id) so the client can unfavorite straight from a worker card without
 * needing to know the join-row id. Scoped to the caller's own
 * favorites — deleting is a no-op-safe 404 if it isn't theirs.
 */
export async function DELETE(request: Request, context: { params: Promise<{ workerId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["CUSTOMER", "ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { workerId } = await context.params;

  const existing = await prisma.favoriteWorker.findUnique({
    where: { userId_workerId: { userId: authed.userId, workerId } },
    select: { id: true },
  });
  if (!existing) return NextResponse.json({ error: "Not in your favorites." }, { status: 404 });

  await prisma.favoriteWorker.delete({ where: { id: existing.id } });
  return NextResponse.json({ deleted: true });
}
