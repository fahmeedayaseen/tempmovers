import { prisma } from "@/lib/db";
import type { WorkerProfile, SubscriptionPlan, WorkerType, VehicleType } from "@prisma/client";

/**
 * Worker-type-specific requirements. A labor-only mover is NOT a carrier —
 * forcing one through vehicle/commercial-insurance/DOT-MC requirements was
 * a real bug (they'd never be able to complete onboarding). Box-truck and
 * semi drivers ARE carriers and need the full vehicle/insurance/DOT-MC
 * treatment.
 */
// Junk removal — VASRUE Digital Media, 28 Oct 2026: a junk-only hauler brings and drives
// the box truck, so it carries the same vehicle and insurance requirements as
// a box-truck driver. A junk-only helper is labor only, like a mover.
export function requiresVehicle(workerType: WorkerType): boolean {
  return workerType === "BOX_TRUCK_DRIVER" || workerType === "SEMI_DRIVER" || workerType === "JUNK_HAULER";
}
export function requiresCommercialVehicleInsurance(workerType: WorkerType): boolean {
  return workerType === "BOX_TRUCK_DRIVER" || workerType === "SEMI_DRIVER" || workerType === "JUNK_HAULER";
}
export function requiresDotMc(workerType: WorkerType): boolean {
  // Box-truck DOT/MC is conditional in the real world (intrastate-only
  // local routes often don't need it) but there's no intrastate/interstate
  // flag in the schema yet to condition on — treating it as not required
  // by default for box trucks and required for semi is the safer default
  // (never blocks a legitimately-exempt box-truck driver on a requirement
  // that doesn't apply, while still gating semi correctly) until that flag
  // exists.
  return workerType === "SEMI_DRIVER";
}

/** Equipment-tier eligibility keyed off the load's actual equipment, not just workerType. */
export function planAllowsLoad({
  plan, workerType, equipmentType,
}: { plan: SubscriptionPlan | null; workerType: WorkerType; equipmentType: VehicleType }): boolean {
  if (!plan) return false;
  if (equipmentType === "BOX_TRUCK") {
    return workerType === "BOX_TRUCK_DRIVER" && ["DRIVER_BASIC", "OWNER_OPERATOR_PRO", "FLEET"].includes(plan);
  }
  if (equipmentType === "SEMI_TRACTOR" || equipmentType === "SEMI_TRACTOR_TRAILER") {
    return workerType === "SEMI_DRIVER" && ["OWNER_OPERATOR_PRO", "FLEET"].includes(plan);
  }
  return false;
}

export type EligibilityContext =
  | "ONBOARDING_PROGRESS"
  | "SUBMISSION"
  | "ADMIN_APPROVAL"
  | "MOVING_JOB_ACCEPTANCE"
  | "FREIGHT_LOAD_REQUEST"
  | "PAYOUT";

export type StepStatus = "NOT_APPLICABLE" | "NOT_STARTED" | "IN_PROGRESS" | "COMPLETE";

export type EligibilityResult = {
  allowed: boolean;
  missingRequirements: string[];
  warnings: string[];
  steps: { key: string; status: StepStatus }[];
  percentComplete: number;
};

/**
 * The one place worker eligibility is computed, for every context. Progress
 * display, submission gating, admin approval, moving-job acceptance,
 * freight-load requests, and payout should all call this — not maintain
 * their own copy of "is this worker ready," which is exactly how mover
 * accounts ended up requiring a vehicle and how insurance rules applied
 * uniformly regardless of worker type.
 */
export async function evaluateWorkerEligibility({
  workerId,
  context,
  equipmentType,
}: {
  workerId: string;
  context: EligibilityContext;
  equipmentType?: VehicleType;
}): Promise<EligibilityResult> {
  const worker = await prisma.workerProfile.findUnique({
    where: { id: workerId },
    include: { vehicles: true, carrierVerification: true, workerMarkets: true, documents: true },
  });

  if (!worker) {
    return { allowed: false, missingRequirements: ["WORKER_NOT_FOUND"], warnings: [], steps: [], percentComplete: 0 };
  }

  const isCarrier = requiresVehicle(worker.workerType);
  const activeVehicle = worker.vehicles.find((v) => v.active);
  const missing: string[] = [];
  const warnings: string[] = [];

  // --- Personal profile ---
  const personal: StepStatus = worker.legalName && worker.dateOfBirth ? "COMPLETE" : worker.legalName || worker.displayName ? "IN_PROGRESS" : "NOT_STARTED";
  if (personal !== "COMPLETE") missing.push("PERSONAL_PROFILE");

  // --- Business/carrier profile (semi only — box-truck can be an individual account) ---
  const businessApplies = worker.workerType === "SEMI_DRIVER";
  const business: StepStatus = !businessApplies
    ? "NOT_APPLICABLE"
    : worker.businessName && worker.carrierVerification?.usdotNumber
      ? "COMPLETE"
      : worker.businessName || worker.carrierVerification
        ? "IN_PROGRESS"
        : "NOT_STARTED";
  if (businessApplies && business !== "COMPLETE") missing.push("BUSINESS_PROFILE");

  // --- Vehicle — NOT APPLICABLE for labor-only movers, never a blocking requirement for them ---
  const vehicleProfileFilled = Boolean(activeVehicle?.year && activeVehicle?.make && activeVehicle?.model && activeVehicle?.plateNumber);
  const vehicle: StepStatus = !isCarrier
    ? "NOT_APPLICABLE"
    : vehicleProfileFilled && worker.vehicleVerificationStatus === "APPROVED"
      ? "COMPLETE"
      : vehicleProfileFilled || activeVehicle
        ? "IN_PROGRESS"
        : "NOT_STARTED";
  if (isCarrier && vehicle !== "COMPLETE") missing.push("VEHICLE_PROFILE");

  // --- Identity/background credentials — required for every worker type ---
  const credentials: StepStatus = worker.identityVerification === "APPROVED" ? "COMPLETE" : worker.identityVerification === "PENDING" ? "NOT_STARTED" : "IN_PROGRESS";
  if (credentials !== "COMPLETE") missing.push("IDENTITY_VERIFICATION");

  // --- Insurance — commercial vehicle+cargo for carriers, general liability check only for movers ---
  const insuranceApplies = requiresCommercialVehicleInsurance(worker.workerType);
  const insurance: StepStatus = !insuranceApplies
    ? "NOT_APPLICABLE"
    : worker.insuranceVerificationStatus === "APPROVED"
      ? "COMPLETE"
      : activeVehicle?.commercialInsurance
        ? "IN_PROGRESS"
        : "NOT_STARTED";
  // A mover's general-liability insurance step is informational, not a hard
  // blocker the way commercial vehicle+cargo insurance is for a carrier —
  // only push it into missingRequirements for carriers.
  if (insuranceApplies && insurance !== "COMPLETE") missing.push("INSURANCE");

  // --- DOT/MC — semi only, by default (see requiresDotMc) ---
  const dotMcApplies = requiresDotMc(worker.workerType);
  const dotMc: StepStatus = !dotMcApplies
    ? "NOT_APPLICABLE"
    : worker.carrierVerification?.decision === "APPROVED" || worker.dotMcVerificationStatus === "APPROVED"
      ? "COMPLETE"
      : worker.carrierVerification || worker.dotMcVerificationStatus === "IN_REVIEW"
        ? "IN_PROGRESS"
        : "NOT_STARTED";
  if (dotMcApplies && dotMc !== "COMPLETE") missing.push("DOT_MC_VERIFICATION");

  // --- Payments (Stripe Connect) — required for every worker type ---
  const payments: StepStatus = worker.stripePayoutsEnabled ? "COMPLETE" : worker.stripeAccountId ? "IN_PROGRESS" : "NOT_STARTED";
  if (payments !== "COMPLETE") missing.push("STRIPE_PAYOUTS_ENABLED");

  // --- Subscription plan ---
  const subscription: StepStatus = worker.subscriptionPlan ? "COMPLETE" : "NOT_STARTED";
  if (subscription !== "COMPLETE") missing.push("SUBSCRIPTION_PLAN_SELECTION");

  // --- Market/territory ---
  const territory: StepStatus = worker.primaryMarketId && worker.workerMarkets.length > 0 ? "COMPLETE" : worker.homeZip ? "IN_PROGRESS" : "NOT_STARTED";
  if (territory !== "COMPLETE") missing.push("MARKET_TERRITORY");

  // --- Document expiration — applies regardless of context; an expired
  // document restricts even an already-approved worker ---
  const now = new Date();
  const expiredDocs = worker.documents.filter((d) => d.status === "APPROVED" && d.expiresAt && d.expiresAt < now);
  if (expiredDocs.length > 0) {
    missing.push("EXPIRED_DOCUMENTS");
    warnings.push(`${expiredDocs.length} previously-approved document(s) have expired.`);
  }
  if (worker.carrierVerification?.expiresAt && worker.carrierVerification.expiresAt < now) {
    missing.push("EXPIRED_FMCSA_VERIFICATION");
  }

  const steps = [
    { key: "personal", status: personal },
    { key: "business", status: business },
    { key: "vehicle", status: vehicle },
    { key: "credentials", status: credentials },
    { key: "insurance", status: insurance },
    { key: "dotMc", status: dotMc },
    { key: "payments", status: payments },
    { key: "subscription", status: subscription },
    { key: "territory", status: territory },
  ];
  const applicable = steps.filter((s) => s.status !== "NOT_APPLICABLE");
  const percentComplete = applicable.length === 0 ? 0 : Math.round((applicable.filter((s) => s.status === "COMPLETE").length / applicable.length) * 100);

  // --- Context-specific top-level checks, on top of the step evaluation ---
  const waiverActive = worker.subscriptionWaivedUntilFirstJob && !worker.firstCompletedJobAt;
  const subscriptionOk = worker.subscriptionStatus === "ACTIVE" || waiverActive;
  if (!subscriptionOk) missing.push("SUBSCRIPTION_NOT_ACTIVE");

  if (context === "MOVING_JOB_ACCEPTANCE" || context === "FREIGHT_LOAD_REQUEST" || context === "PAYOUT") {
    // These contexts check a worker who's supposed to ALREADY be approved
    // and are asking "do they still qualify for continued access" — so the
    // status fields themselves are valid gates here.
    if (worker.operationalStatus !== "ACTIVE") missing.push(`ACCOUNT_${worker.operationalStatus}`);
    if (worker.onboardingStatus !== "COMPLETE") missing.push("ONBOARDING_NOT_COMPLETE");
    if (worker.overallVerificationStatus !== "APPROVED") missing.push("VERIFICATION_NOT_APPROVED");
  }
  // ADMIN_APPROVAL deliberately does NOT check operationalStatus/
  // onboardingStatus/overallVerificationStatus — those are exactly what the
  // approval action is about to set. Checking them here would be circular:
  // a worker pending their first approval would always fail a check for
  // "is already approved." ADMIN_APPROVAL instead validates the underlying
  // requirements (steps above) independent of the status fields.
  if (context === "MOVING_JOB_ACCEPTANCE" && !worker.acceptingJobs) missing.push("NOT_ACCEPTING_JOBS");
  if (context === "FREIGHT_LOAD_REQUEST" && equipmentType && !planAllowsLoad({ plan: worker.subscriptionPlan, workerType: worker.workerType, equipmentType })) {
    missing.push("PLAN_OR_EQUIPMENT_NOT_ELIGIBLE");
  }

  // Onboarding-progress display and initial submission care about step
  // completion; approval/work-acceptance/payout care about the full gate.
  const allowed = context === "ONBOARDING_PROGRESS"
    ? true // progress is informational, never itself a pass/fail gate
    : missing.length === 0;

  return { allowed, missingRequirements: missing, warnings, steps, percentComplete };
}

/** Advances INCOMPLETE -> IN_PROGRESS on first save; a no-op otherwise (idempotent, safe to call from every save endpoint). */
export async function markOnboardingStarted(workerId: string) {
  await prisma.workerProfile.updateMany({
    where: { id: workerId, onboardingStatus: "INCOMPLETE" },
    data: { onboardingStatus: "IN_PROGRESS" },
  });
}

// This WorkerProfile re-export is unused now that every call site has
// migrated to evaluateWorkerEligibility directly — kept in case a narrower
// future helper needs the type without importing the whole client.
export type { WorkerProfile };
