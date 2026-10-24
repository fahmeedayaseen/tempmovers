import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";

/**
 * A customer's view of invitations they've sent for a specific job —
 * distinct from GET /api/jobs/[jobId]/assignments, which exists for
 * the Approve Hours flow and deliberately only shows CHECKED_OUT/
 * APPROVED. This shows every invitation-relevant status
 * (INVITED/ACCEPTED/DECLINED), which that route was never meant to
 * surface and shouldn't be widened to, since Approve Hours genuinely
 * only cares about the narrower set.
 */
export async function GET(request: Request, context: { params: Promise<{ jobId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["CUSTOMER", "ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { jobId } = await context.params;

  const job = await prisma.job.findUnique({ where: { id: jobId }, include: { customer: true } });
  if (!job) return NextResponse.json({ error: "Job not found." }, { status: 404 });
  if (authed.role === "CUSTOMER" && job.customer.userId !== authed.userId) {
    return NextResponse.json({ error: "Not your job." }, { status: 403 });
  }

  const invitations = await prisma.assignment.findMany({
    where: { jobId, status: { in: ["INVITED", "ACCEPTED", "DECLINED", "CHECKED_IN", "CHECKED_OUT", "APPROVED"] } },
    select: { id: true, status: true, expiresAt: true, respondedAt: true, createdAt: true, worker: { select: { id: true, displayName: true } } },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ invitations });
}
