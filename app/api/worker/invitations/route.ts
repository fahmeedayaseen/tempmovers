import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";

/**
 * A mover's inbox of pending job invitations — only shows non-expired
 * ones. Expiration itself is enforced lazily (checked again, and
 * authoritatively, at accept/decline time) rather than via a cron job
 * that flips status to a separate EXPIRED value — there's no
 * AssignmentStatus.EXPIRED, and adding one would mean an invitation
 * that's simply too old looks identical in the data model to one that
 * was actively acted on, when it's neither.
 */
export async function GET(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["MOVER"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const worker = await prisma.workerProfile.findUnique({ where: { userId: authed.userId } });
  if (!worker) return NextResponse.json({ error: "Worker profile not found." }, { status: 404 });

  const invitations = await prisma.assignment.findMany({
    where: { workerId: worker.id, status: "INVITED", expiresAt: { gt: new Date() } },
    select: {
      id: true, expiresAt: true, createdAt: true, agreedEarningsCents: true, scheduledHours: true,
      job: { select: { id: true, title: true, type: true, startsAt: true, market: { select: { name: true, state: true } } } },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ invitations });
}
