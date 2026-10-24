import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";

const schema = z.object({ latitude: z.number(), longitude: z.number() });

export async function POST(request: Request, context: { params: Promise<{ assignmentId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["MOVER", "DRIVER"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { assignmentId } = await context.params;
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const assignment = await prisma.assignment.findUnique({ where: { id: assignmentId }, include: { worker: true } });
  if (!assignment) return NextResponse.json({ error: "Assignment not found." }, { status: 404 });
  if (assignment.worker.userId !== authed.userId) return NextResponse.json({ error: "Not your assignment." }, { status: 403 });
  if (assignment.status !== "CHECKED_IN" || !assignment.checkInAt) {
    return NextResponse.json({ error: "Must check in before checking out." }, { status: 409 });
  }

  const actualHours = Math.max(0, (Date.now() - assignment.checkInAt.getTime()) / 3_600_000);
  const updated = await prisma.assignment.update({
    where: { id: assignmentId },
    data: {
      status: "CHECKED_OUT", checkOutAt: new Date(),
      checkOutLatitude: parsed.data.latitude, checkOutLongitude: parsed.data.longitude,
      actualHours,
    },
  });
  await prisma.job.update({ where: { id: assignment.jobId }, data: { status: "REVIEW_PENDING" } });
  return NextResponse.json({ assignment: updated });
}
