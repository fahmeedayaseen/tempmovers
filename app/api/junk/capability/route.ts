import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { isJunkOnlyWorkerType, junkCrewRoleFor } from "@/lib/junk/crew";

/**
 * Junk removal — VASRUE Digital Media, 28 October 2026.
 *
 * The capability opt-in (Carl's junk spec §2a): an existing mover or box-truck
 * driver switches junk removal jobs on or off without giving up their other
 * work. Junk-only accounts always receive junk jobs, and semi drivers never
 * do, so neither can toggle this. Switching it off does not touch seats the
 * worker already holds.
 */
const schema = z.object({ enabled: z.boolean() });

export async function PATCH(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["MOVER", "DRIVER"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const worker = await prisma.workerProfile.findUnique({ where: { userId: authed.userId }, select: { id: true, workerType: true } });
  if (!worker) return NextResponse.json({ error: "Worker profile not found." }, { status: 404 });
  if (isJunkOnlyWorkerType(worker.workerType)) {
    return NextResponse.json({ error: "Junk-only accounts always receive junk removal jobs." }, { status: 409 });
  }
  if (!junkCrewRoleFor(worker.workerType)) {
    return NextResponse.json({ error: "This account type can't take junk removal jobs." }, { status: 403 });
  }

  const updated = await prisma.workerProfile.update({
    where: { id: worker.id },
    data: { junkRemovalEnabled: parsed.data.enabled },
    select: { junkRemovalEnabled: true },
  });
  await prisma.auditLog.create({
    data: { actorId: authed.userId, action: "JUNK_CAPABILITY_CHANGED", entityType: "WorkerProfile", entityId: worker.id, details: { enabled: parsed.data.enabled } },
  });
  return NextResponse.json({ junkRemovalEnabled: updated.junkRemovalEnabled });
}
