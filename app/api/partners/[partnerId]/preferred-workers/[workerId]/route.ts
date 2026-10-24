import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { resolvePartnerWriteAccess } from "@/lib/partner-permissions";

const patchSchema = z.object({ priority: z.number().int().min(1).max(100) });

export async function PATCH(request: Request, context: { params: Promise<{ partnerId: string; workerId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["CUSTOMER", "ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { partnerId, workerId } = await context.params;
  const access = await resolvePartnerWriteAccess(prisma, partnerId, authed);
  if (!access.allowed) return NextResponse.json({ error: access.reason }, { status: access.reason === "Partner not found." ? 404 : 403 });

  const parsed = patchSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const existing = await prisma.preferredWorker.findUnique({ where: { partnerId_workerId: { partnerId, workerId } } });
  if (!existing) return NextResponse.json({ error: "This worker is not in your preferred network." }, { status: 404 });

  const updated = await prisma.preferredWorker.update({
    where: { partnerId_workerId: { partnerId, workerId } },
    data: { priority: parsed.data.priority },
  });

  await prisma.auditLog.create({
    data: { actorId: authed.userId, action: "PREFERRED_WORKER_PRIORITY_CHANGED", entityType: "PreferredWorker", entityId: existing.id, details: { partnerId, workerId, oldPriority: existing.priority, newPriority: parsed.data.priority } },
  });

  return NextResponse.json({ preferredWorker: updated });
}

export async function DELETE(request: Request, context: { params: Promise<{ partnerId: string; workerId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["CUSTOMER", "ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { partnerId, workerId } = await context.params;
  const access = await resolvePartnerWriteAccess(prisma, partnerId, authed);
  if (!access.allowed) return NextResponse.json({ error: access.reason }, { status: access.reason === "Partner not found." ? 404 : 403 });

  const existing = await prisma.preferredWorker.findUnique({ where: { partnerId_workerId: { partnerId, workerId } } });
  if (!existing) return NextResponse.json({ error: "This worker is not in your preferred network." }, { status: 404 });

  // Deliberately only removes the roster entry — removing a preferred
  // worker affects future opportunities only. It never touches any
  // Assignment, Payout, or CarrierRouteInvitation from when this worker
  // previously worked for this partner; historical records are
  // untouched by design, not by omission.
  await prisma.preferredWorker.delete({ where: { partnerId_workerId: { partnerId, workerId } } });

  await prisma.auditLog.create({
    data: { actorId: authed.userId, action: "PREFERRED_WORKER_REMOVED", entityType: "PreferredWorker", entityId: existing.id, details: { partnerId, workerId } },
  });

  return NextResponse.json({ removed: true });
}
