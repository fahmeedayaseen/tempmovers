import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { normalizeDisplayOrder } from "@/lib/portfolio/cleanup";

/**
 * Atomically reorder the owner's portfolio (Phase 5.5). The client sends
 * the desired id order; the server confirms every id is owned and
 * non-deleted, normalizes to gap-free 0..n-1 displayOrder, and writes
 * them all in one transaction so a partial reorder can't leave the
 * gallery in an inconsistent order.
 */
const schema = z.object({ orderedIds: z.array(z.string().cuid()).min(1).max(50) });

export async function POST(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["MOVER", "DRIVER"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const worker = await prisma.workerProfile.findUnique({ where: { userId: authed.userId }, select: { id: true } });
  if (!worker) return NextResponse.json({ error: "Worker profile not found." }, { status: 404 });

  // Confirm every id belongs to this worker and isn't deleted — reject
  // the whole reorder if any id is foreign, rather than silently skipping.
  const owned = await prisma.portfolioMedia.findMany({ where: { id: { in: parsed.data.orderedIds }, workerId: worker.id, deletedAt: null }, select: { id: true } });
  const ownedIds = new Set(owned.map(m => m.id));
  if (ownedIds.size !== parsed.data.orderedIds.length || parsed.data.orderedIds.some(id => !ownedIds.has(id))) {
    return NextResponse.json({ error: "One or more items are not in your portfolio." }, { status: 400 });
  }

  const updates = normalizeDisplayOrder(parsed.data.orderedIds);
  await prisma.$transaction(updates.map(u => prisma.portfolioMedia.update({ where: { id: u.id }, data: { displayOrder: u.displayOrder } })));

  await prisma.auditLog.create({
    data: { actorId: authed.userId, action: "PORTFOLIO_REORDER", entityType: "WorkerProfile", entityId: worker.id, details: { count: updates.length } },
  });

  return NextResponse.json({ reordered: updates.length });
}
