import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";

const TRANSITIONS: Record<string, string[]> = {
  ASSIGNED: ["IN_TRANSIT", "CANCELED"],
  IN_TRANSIT: ["DELIVERED", "CANCELED"],
  DELIVERED: ["POD_UPLOADED"],
  POD_UPLOADED: ["SETTLED"],
};

const schema = z.object({ status: z.enum(["IN_TRANSIT", "DELIVERED", "SETTLED", "CANCELED"]) });

export async function POST(request: Request, context: { params: Promise<{ loadId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["MOVER", "DRIVER", "ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { loadId } = await context.params;
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const load = await prisma.carrierRoute.findUnique({ where: { id: loadId }, include: { assignedWorker: true } });
  if (!load) return NextResponse.json({ error: "Load not found." }, { status: 404 });
  if (authed.role !== "ADMIN" && load.assignedWorker?.userId !== authed.userId) {
    return NextResponse.json({ error: "This load isn't assigned to you." }, { status: 403 });
  }

  const allowed = TRANSITIONS[load.status] ?? [];
  if (!allowed.includes(parsed.data.status)) {
    return NextResponse.json({ error: `Cannot move from ${load.status} to ${parsed.data.status}.` }, { status: 409 });
  }

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.carrierRoute.update({
      where: { id: loadId }, data: { status: parsed.data.status },
      select: { id: true, status: true, updatedAt: true, assignedWorkerId: true },
    });
    if (parsed.data.status === "SETTLED" && result.assignedWorkerId) {
      const worker = await tx.workerProfile.findUnique({ where: { id: result.assignedWorkerId }, select: { completedJobs: true, firstCompletedJobAt: true } });
      const isFirstCompletion = worker && worker.completedJobs < 1 && !worker.firstCompletedJobAt;
      await tx.workerProfile.update({
        where: { id: result.assignedWorkerId },
        data: { completedJobs: { increment: 1 }, ...(isFirstCompletion && { firstCompletedJobAt: new Date() }) },
      });
    }
    return result;
  });
  return NextResponse.json({ load: updated });
}
