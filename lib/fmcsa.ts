import { prisma } from "@/lib/db";
import { syncWorkerComplianceTracks } from "@/lib/compliance/sync-tracks";

/**
 * FMCSA QCMobile API client. This is a public, documented government API
 * (https://mobile.fmcsa.dot.gov/qc/services), so this is a real
 * implementation against its documented contract — not a stub. It has NOT
 * been tested against the live endpoint in this environment (no network
 * access here), so treat the first real call in your dev environment as
 * the actual integration test.
 *
 * FMCSA data is a BASELINE check only. A carrier can pass this and still
 * fail insurance, W-9, Stripe identity, or vehicle-document verification —
 * those stay as separate, existing checks. Never gate a payout or job
 * acceptance on this alone.
 */

const FMCSA_BASE_URL = process.env.FMCSA_API_BASE_URL ?? "https://mobile.fmcsa.dot.gov/qc/services";

export class FmcsaNotConfiguredError extends Error {
  constructor() {
    super("FMCSA_WEB_KEY is not configured.");
  }
}

type FmcsaCarrierResponse = {
  content?: {
    carrier?: {
      legalName?: string;
      dbaName?: string;
      statusCode?: string; // "A" = active, "I" = inactive
      allowedToOperate?: string; // "Y" / "N"
      outOfServiceDate?: string | null;
      usdotNumber?: number;
    };
  };
};

function decideFromResponse(data: FmcsaCarrierResponse): "APPROVED" | "REJECTED" {
  const carrier = data.content?.carrier;
  if (!carrier) return "REJECTED";
  const active = carrier.statusCode === "A";
  const allowed = carrier.allowedToOperate === "Y";
  const noOos = !carrier.outOfServiceDate;
  return active && allowed && noOos ? "APPROVED" : "REJECTED";
}

/**
 * Looks up a carrier by USDOT number and upserts a CarrierVerification row.
 * Throws FmcsaNotConfiguredError if no web key is set — callers should
 * catch this and surface a clear "verification unavailable" state rather
 * than silently treating an unconfigured check as a pass or fail.
 */
export async function verifyCarrierByUsdot(workerId: string, usdotNumber: string) {
  const webKey = process.env.FMCSA_WEB_KEY;
  if (!webKey) throw new FmcsaNotConfiguredError();

  const url = `${FMCSA_BASE_URL}/carriers/${encodeURIComponent(usdotNumber)}?webKey=${encodeURIComponent(webKey)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`FMCSA lookup failed with status ${res.status}.`);
  }
  const data = (await res.json()) as FmcsaCarrierResponse;
  const decision = decideFromResponse(data);
  const now = new Date();
  // FMCSA status can change (insurance lapses, authority revoked); a
  // verification is only trusted for a limited window before it must be
  // refreshed — 30 days is conservative for a marketplace at this stage.
  const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const verification = await prisma.carrierVerification.upsert({
    where: { workerId },
    update: {
      usdotNumber,
      legalName: data.content?.carrier?.legalName ?? null,
      operatingStatus: data.content?.carrier?.statusCode ?? null,
      rawResponse: data as object,
      decision,
      verifiedAt: now,
      expiresAt,
    },
    create: {
      workerId,
      usdotNumber,
      legalName: data.content?.carrier?.legalName ?? null,
      operatingStatus: data.content?.carrier?.statusCode ?? null,
      rawResponse: data as object,
      decision,
      verifiedAt: now,
      expiresAt,
    },
  });

  await prisma.workerProfile.update({
    where: { id: workerId },
    data: { dotMcVerificationStatus: decision === "APPROVED" ? "APPROVED" : "REJECTED" },
  });

  await syncWorkerComplianceTracks(prisma, workerId);

  return verification;
}

/** True if the worker's FMCSA check is approved and not past its expiry. */
export function isCarrierVerificationCurrent(verification: { decision: string; expiresAt: Date | null } | null): boolean {
  if (!verification) return false;
  if (verification.decision !== "APPROVED") return false;
  if (!verification.expiresAt) return false;
  return verification.expiresAt.getTime() > Date.now();
}

/**
 * Re-runs the FMCSA check for every carrier whose verification has expired.
 * Intended to run on a schedule (Vercel Cron or an external scheduler —
 * see README) roughly every 24 hours, per FMCSA_REVERIFY_DAYS.
 *
 * A carrier whose authority comes back REJECTED on reverification is
 * restricted immediately (operationalStatus -> RESTRICTED) — this is the
 * one FMCSA-driven action that's safe to automate, unlike background-check
 * adverse action: FMCSA operating-authority status is the government's own
 * live record, not a private report requiring FCRA notice/dispute process.
 */
export async function reverifyExpiredCarriers(): Promise<{ checked: number; restricted: number; failed: number }> {
  const expired = await prisma.carrierVerification.findMany({
    where: { expiresAt: { lte: new Date() } },
    select: { workerId: true, usdotNumber: true },
  });

  let restricted = 0;
  let failed = 0;

  for (const carrier of expired) {
    if (!carrier.usdotNumber) continue;
    try {
      const result = await verifyCarrierByUsdot(carrier.workerId, carrier.usdotNumber);
      if (result.decision !== "APPROVED") {
        await prisma.workerProfile.update({
          where: { id: carrier.workerId },
          data: { operationalStatus: "RESTRICTED" },
        });
        await prisma.auditLog.create({
          data: { action: "WORKER_RESTRICTED_FMCSA_REVERIFY", entityType: "WorkerProfile", entityId: carrier.workerId, details: { decision: result.decision } },
        });
        restricted += 1;
      }
    } catch {
      failed += 1;
    }
  }

  return { checked: expired.length, restricted, failed };
}
