import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { blockUnlessFunded } from "@/lib/payments/funding";

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
  if (assignment.status !== "ACCEPTED") return NextResponse.json({ error: `Cannot check in from status ${assignment.status}.` }, { status: 409 });
  // Pay before dispatch — VASRUE Digital Media, 29 Oct 2026: service starts
  // only on a funded job, decided here on the server at the moment of check-in.
  const job = await prisma.job.findUnique({ where: { id: assignment.jobId }, select: { status: true } });
  if (!job || job.status === "CANCELED") return NextResponse.json({ error: "This job was canceled." }, { status: 409 });
  const unfunded = await blockUnlessFunded({ type: "JOB", id: assignment.jobId }, { action: "started", actorUserId: authed.userId });
  if (unfunded) return unfunded;

  const updated = await prisma.assignment.update({
    where: { id: assignmentId },
    data: {
      status: "CHECKED_IN", checkInAt: new Date(),
      checkInLatitude: parsed.data.latitude, checkInLongitude: parsed.data.longitude,
    },
  });
  await prisma.job.update({ where: { id: assignment.jobId }, data: { status: "IN_PROGRESS" } });
  return NextResponse.json({ assignment: updated });
}
