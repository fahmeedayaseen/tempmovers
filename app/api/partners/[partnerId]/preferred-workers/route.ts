import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { SAFE_WORKER_SELECT } from "@/lib/access/sanitize-worker";
import { resolvePartnerReadAccess, resolvePartnerWriteAccess } from "@/lib/partner-permissions";

/**
 * Preferred-worker roster management for a partner organization —
 * PreferredWorker already existed in the schema and was correctly
 * enforced as a load-visibility gate, but nothing anywhere ever
 * created one. This is that missing piece.
 */
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

  const preferredWorkers = await prisma.preferredWorker.findMany({
    where: { partnerId },
    select: { id: true, priority: true, createdAt: true, worker: { select: SAFE_WORKER_SELECT } },
    orderBy: { priority: "asc" },
  });

  return NextResponse.json({ preferredWorkers });
}

const addSchema = z.object({ workerId: z.string().cuid(), priority: z.number().int().min(1).max(100).optional() });

export async function POST(request: Request, context: { params: Promise<{ partnerId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["CUSTOMER", "ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { partnerId } = await context.params;
  const access = await resolvePartnerWriteAccess(prisma, partnerId, authed);
  if (!access.allowed) return NextResponse.json({ error: access.reason }, { status: access.reason === "Partner not found." ? 404 : 403 });

  const parsed = addSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const worker = await prisma.workerProfile.findUnique({ where: { id: parsed.data.workerId } });
  if (!worker) return NextResponse.json({ error: "Worker not found." }, { status: 404 });

  const existing = await prisma.preferredWorker.findUnique({
    where: { partnerId_workerId: { partnerId, workerId: parsed.data.workerId } },
  });
  if (existing) return NextResponse.json({ error: "This worker is already in your preferred network.", code: "DUPLICATE_PREFERRED_WORKER" }, { status: 409 });

  const created = await prisma.preferredWorker.create({
    data: { partnerId, workerId: parsed.data.workerId, priority: parsed.data.priority ?? 1 },
  });

  await prisma.auditLog.create({
    data: { actorId: authed.userId, action: "PREFERRED_WORKER_ADDED", entityType: "PreferredWorker", entityId: created.id, details: { partnerId, workerId: parsed.data.workerId, priority: created.priority } },
  });

  return NextResponse.json({ preferredWorker: created }, { status: 201 });
}
