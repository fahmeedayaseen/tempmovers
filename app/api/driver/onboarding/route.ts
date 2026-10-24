import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { evaluateWorkerEligibility } from "@/lib/worker-eligibility";

const STEP_LABELS: Record<string, string> = {
  personal: "Personal profile", business: "Business & carrier profile", vehicle: "Vehicle profile",
  credentials: "Identity & background", insurance: "Insurance", dotMc: "DOT/MC verification",
  payments: "Payments & tax setup", subscription: "Subscription plan", territory: "Market & territory",
};

export async function GET(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["MOVER", "DRIVER"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const worker = await prisma.workerProfile.findUnique({ where: { userId: authed.userId } });
  if (!worker) return NextResponse.json({ error: "Worker profile not found." }, { status: 404 });

  const evaluation = await evaluateWorkerEligibility({ workerId: worker.id, context: "ONBOARDING_PROGRESS" });
  const nextStep = evaluation.steps.find((s) => s.status !== "COMPLETE" && s.status !== "NOT_APPLICABLE")?.key ?? null;

  // Previously missing entirely: this is the separate compliance gate
  // checkOpportunityAccess() enforces (WorkerCompliance.adminApprovalStatus)
  // — distinct from every individual credential-track field evaluateWorkerEligibility
  // already reports above (identity, license, insurance, etc.) and from
  // worker.operationalStatus (the general onboarding approval). A worker
  // could see every step above as COMPLETE and still be correctly blocked
  // from requesting/accepting real work by this gate specifically, with
  // no visibility into why until now.
  const compliance = await prisma.workerCompliance.findUnique({ where: { workerId: worker.id } });
  const complianceStatus = compliance?.adminApprovalStatus ?? "PENDING";

  return NextResponse.json({
    percentComplete: evaluation.percentComplete,
    accountStatus: worker.operationalStatus,
    onboardingStatus: worker.onboardingStatus,
    verificationStatus: worker.overallVerificationStatus,
    complianceStatus,
    complianceApproved: complianceStatus === "APPROVED",
    workerType: worker.workerType,
    nextRequiredStep: nextStep,
    steps: evaluation.steps.map((s) => ({ key: s.key, label: STEP_LABELS[s.key] ?? s.key, status: s.status })),
    warnings: evaluation.warnings,
  });
}
