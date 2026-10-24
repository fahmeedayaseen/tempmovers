import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { SAFE_WORKER_SELECT } from "@/lib/access/sanitize-worker";

/**
 * Favorite workers (Phase 5) — a customer's personal bookmarks.
 * Deliberately user-scoped and distinct from PreferredWorker (Phase 2),
 * which is partner-org-scoped and priority-ranked. A favorite is a
 * private star with no priority and no partner. Returned worker data
 * flows through SAFE_WORKER_SELECT like everywhere else.
 */
const createSchema = z.object({ workerId: z.string().cuid() });

export async function GET(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["CUSTOMER", "ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const favorites = await prisma.favoriteWorker.findMany({
    where: { userId: authed.userId },
    orderBy: { createdAt: "desc" },
    select: { id: true, createdAt: true, worker: { select: SAFE_WORKER_SELECT } },
  });

  return NextResponse.json({ favorites });
}

export async function POST(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["CUSTOMER", "ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const parsed = createSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const worker = await prisma.workerProfile.findUnique({ where: { id: parsed.data.workerId }, select: { id: true } });
  if (!worker) return NextResponse.json({ error: "Worker not found." }, { status: 404 });

  // upsert so favoriting an already-favorited worker is idempotent
  // rather than a unique-constraint error.
  const favorite = await prisma.favoriteWorker.upsert({
    where: { userId_workerId: { userId: authed.userId, workerId: parsed.data.workerId } },
    update: {},
    create: { userId: authed.userId, workerId: parsed.data.workerId },
    select: { id: true, createdAt: true, worker: { select: SAFE_WORKER_SELECT } },
  });

  return NextResponse.json({ favorite }, { status: 201 });
}
