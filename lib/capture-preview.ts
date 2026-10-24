import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { MINIMUM_JOB_HOURS } from "@/lib/pricing";

type Client = Prisma.TransactionClient | typeof prisma;

/**
 * Single source of truth for a job's final capture amount — shared by
 * the capture route (app/api/jobs/[jobId]/capture-payment) and the
 * capture-ready queue (app/api/admin/captures), after an audit found
 * the queue was displaying job.estimatedTotalCents while the capture
 * route actually charges a different, hours-derived finalTotalCents.
 * An admin could see one amount in the queue and capture a different
 * one — correct math, misleading presentation. Extracting this into
 * one function is what makes that drift structurally impossible: both
 * callers compute from the exact same code, not two copies that could
 * diverge again later.
 *
 * Returns `ok: false` (with a human-readable reason) rather than a
 * number whenever the job isn't ACTUALLY ready — e.g. hours not yet
 * customer-approved — so the queue can show that honestly instead of
 * a number that would fail if someone clicked Capture.
 */
type JobForCapture = {
  id: string;
  platformFeePerHourCents: number;
  urgentPremiumCents: number;
  bookingProtectionFeeCents: number;
};

export type CapturePreviewResult =
  | { ok: true; finalLaborCents: number; finalPlatformFeeCents: number; finalTotalCents: number; billableAssignments: Array<{ id: string; workerId: string; scheduledHours: Prisma.Decimal; actualHours: Prisma.Decimal | null; agreedEarningsCents: number }> }
  | { ok: false; reason: string };

export async function calculateJobFinalCaptureAmount(
  client: Client,
  job: JobForCapture,
): Promise<CapturePreviewResult> {
  const billableAssignments = await client.assignment.findMany({
    where: { jobId: job.id, status: { in: ["CHECKED_OUT", "APPROVED"] } },
  });

  if (billableAssignments.length === 0) {
    return { ok: false, reason: "No billable assignments found for this job." };
  }
  if (billableAssignments.some((a) => a.status !== "APPROVED" || !a.customerApprovedAt || a.actualHours == null)) {
    return { ok: false, reason: "All worker hours must be customer-approved before capture." };
  }

  const finalLaborCents = billableAssignments.reduce((sum, a) => {
    const billedHours = Math.max(MINIMUM_JOB_HOURS, Number(a.actualHours));
    return sum + Math.round(a.agreedEarningsCents * billedHours);
  }, 0);

  const finalPlatformFeeCents = billableAssignments.reduce((sum, a) => {
    const billedHours = Math.max(MINIMUM_JOB_HOURS, Number(a.actualHours));
    return sum + Math.round(job.platformFeePerHourCents * billedHours);
  }, 0);

  const finalTotalCents = finalLaborCents + finalPlatformFeeCents + job.urgentPremiumCents + job.bookingProtectionFeeCents;

  return { ok: true, finalLaborCents, finalPlatformFeeCents, finalTotalCents, billableAssignments };
}
