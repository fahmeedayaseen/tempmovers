import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

type DbClient = typeof prisma | Prisma.TransactionClient;
type Track = "NOT_STARTED" | "IN_PROGRESS" | "PENDING_REVIEW" | "APPROVED" | "RESTRICTED" | "SUSPENDED" | "EXPIRED";

function fromDocumentStatus(status?: string | null): Track {
  if (!status) return "NOT_STARTED";
  if (status === "APPROVED") return "APPROVED";
  if (status === "REJECTED") return "RESTRICTED";
  if (status === "EXPIRED") return "EXPIRED";
  return "PENDING_REVIEW"; // PENDING
}

function fromBackgroundCheck(status?: string | null, result?: string | null): Track {
  if (!status) return "NOT_STARTED";
  if (result === "clear") return "APPROVED";
  if (result === "consider") return "PENDING_REVIEW"; // never auto-restrict — see lib/checkr.ts's own caution
  if (status === "complete") return result ? "PENDING_REVIEW" : "APPROVED";
  return "IN_PROGRESS";
}

function fromCarrierVerification(decision?: string | null, expiresAt?: Date | null): Track {
  if (!decision) return "NOT_STARTED";
  if (decision === "APPROVED" && expiresAt && expiresAt.getTime() < Date.now()) return "EXPIRED";
  if (decision === "APPROVED") return "APPROVED";
  if (decision === "REJECTED") return "RESTRICTED";
  return "PENDING_REVIEW";
}

function fromInsurancePolicy(status?: string | null): Track {
  if (!status) return "NOT_STARTED";
  if (status === "ACTIVE") return "APPROVED";
  if (["LAPSED", "CANCELLED", "EXPIRED"].includes(status)) return "RESTRICTED";
  return "PENDING_REVIEW";
}

/**
 * Recomputes WorkerCompliance's individual per-credential-track fields
 * from the actual underlying records (WorkerDocument, BackgroundCheck,
 * CarrierVerification, InsurancePolicy) — these were previously left at
 * their NOT_STARTED default forever, since nothing wrote to them. The
 * overall adminApprovalStatus gate (set only by an admin via
 * POST /api/admin/compliance/[workerId]/decide) is untouched here — this
 * only keeps the informational per-track breakdown in sync with reality
 * so an admin reviewing a worker sees accurate detail, not defaults.
 *
 * Approximation worth flagging: there's no distinct "MVR" document or
 * record type in this schema — motor vehicle record checks come back as
 * part of the same Checkr background-check report for driver worker
 * types, so mvrStatus mirrors backgroundStatus for drivers and stays
 * NOT_STARTED for movers (who don't drive as part of the job).
 *
 * Call this after any event that could change one of these tracks:
 * document decision, Checkr webhook, FMCSA verification, Certificial
 * webhook. Idempotent and side-effect-free beyond the upsert itself.
 */
export async function syncWorkerComplianceTracks(client: DbClient, workerId: string): Promise<void> {
  const worker = await client.workerProfile.findUnique({
    where: { id: workerId },
    include: {
      documents: { orderBy: { submittedAt: "desc" } },
      backgroundChecks: { orderBy: { createdAt: "desc" }, take: 1 },
      carrierVerification: true,
      insurancePolicies: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });
  if (!worker) return;

  const latestDocByType = (type: string) => worker.documents.find((d) => d.type === type);
  const latestBackgroundCheck = worker.backgroundChecks[0];
  const latestInsurancePolicy = worker.insurancePolicies[0];
  const isDriver = worker.workerType === "BOX_TRUCK_DRIVER" || worker.workerType === "SEMI_DRIVER";
  const isSemi = worker.workerType === "SEMI_DRIVER";

  const identityStatus = fromDocumentStatus(latestDocByType("DRIVERS_LICENSE")?.status ?? worker.identityVerification);
  const backgroundStatus = fromBackgroundCheck(latestBackgroundCheck?.status, latestBackgroundCheck?.result);
  const licenseStatus = isDriver ? fromDocumentStatus(latestDocByType(isSemi ? "CDL" : "DRIVERS_LICENSE")?.status) : "NOT_STARTED";
  const mvrStatus: Track = isDriver ? backgroundStatus : "NOT_STARTED";
  const insuranceStatus = latestInsurancePolicy
    ? fromInsurancePolicy(latestInsurancePolicy.status)
    : fromDocumentStatus(latestDocByType("CERTIFICATE_OF_INSURANCE")?.status ?? worker.insuranceVerificationStatus);
  const vehicleStatus = isDriver ? fromDocumentStatus(latestDocByType("VEHICLE_REGISTRATION")?.status ?? worker.vehicleVerificationStatus) : "NOT_STARTED";
  const dotStatus = isSemi ? fromCarrierVerification(worker.carrierVerification?.decision, worker.carrierVerification?.expiresAt) : "NOT_STARTED";
  const mcStatus = dotStatus; // Same FMCSA record covers both DOT and MC authority status.
  const cdlStatus = isSemi ? fromDocumentStatus(latestDocByType("CDL")?.status) : "NOT_STARTED";

  await client.workerCompliance.upsert({
    where: { workerId },
    update: { identityStatus, backgroundStatus, licenseStatus, mvrStatus, insuranceStatus, vehicleStatus, dotStatus, mcStatus, cdlStatus },
    create: { workerId, identityStatus, backgroundStatus, licenseStatus, mvrStatus, insuranceStatus, vehicleStatus, dotStatus, mcStatus, cdlStatus },
  });
}
