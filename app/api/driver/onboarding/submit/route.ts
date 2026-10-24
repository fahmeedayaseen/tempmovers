import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { evaluateWorkerEligibility } from "@/lib/worker-eligibility";

/**
 * Moves onboarding from INCOMPLETE/IN_PROGRESS to SUBMITTED, which puts the
 * worker into the admin review queue. This does NOT approve anything —
 * that's a separate, admin-only action (see
 * POST /api/admin/workers/[workerId]/review). Refuses to submit until every
 * applicable step is actually complete, using the same shared evaluator as
 * onboarding progress, admin approval, and work acceptance — never a
 * separate copy of the rules that could drift.
 */
export async function POST(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["MOVER", "DRIVER"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const worker = await prisma.workerProfile.findUnique({ where: { userId: authed.userId } });
  if (!worker) return NextResponse.json({ error: "Worker profile not found." }, { status: 404 });

  const evaluation = await evaluateWorkerEligibility({ workerId: worker.id, context: "SUBMISSION" });
  const stepsIncomplete = evaluation.steps.filter((s) => s.status !== "COMPLETE" && s.status !== "NOT_APPLICABLE").map((s) => s.key);

  if (stepsIncomplete.length > 0) {
    return NextResponse.json({ error: "Onboarding is not yet complete.", incompleteSteps: stepsIncomplete }, { status: 409 });
  }

  const updated = await prisma.workerProfile.update({
    where: { id: worker.id },
    data: { onboardingStatus: "SUBMITTED", overallVerificationStatus: "IN_REVIEW", submittedAt: new Date() },
  });

  await prisma.auditLog.create({
    data: { actorId: authed.userId, action: "ONBOARDING_SUBMITTED", entityType: "WorkerProfile", entityId: worker.id },
  });

  return NextResponse.json({ worker: updated });
}
