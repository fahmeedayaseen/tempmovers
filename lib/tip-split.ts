import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

type Client = Prisma.TransactionClient | typeof prisma;

/**
 * Determines eligibility and the even worker-by-worker split for a tip
 * on a moving job — one canonical function, called both when a tip is
 * created (to confirm the job is actually eligible before charging the
 * customer) and when the payment succeeds (to actually create the
 * TipAllocation rows), so the two can't compute a different split for
 * the same job depending on when they're called.
 *
 * Eligibility mirrors capture eligibility (COMPLETED + CAPTURED) rather
 * than reusing calculateJobFinalCaptureAmount() directly — a tip must
 * come after the job is actually paid for, but doesn't need that
 * function's hours-based amount calculation at all.
 *
 * Split is even across every APPROVED assignment — the same workers who
 * actually got paid for the job, via the same status this codebase
 * already uses everywhere else to mean "this worker's labor was
 * confirmed and compensated" (capture-preview.ts uses the identical
 * CHECKED_OUT/APPROVED-then-APPROVED-required logic for the same
 * reason). Remainder cents from integer division go to the first
 * worker (by id) rather than being lost or over-allocated.
 */
export type TipSplitResult =
  | { ok: true; workerIds: string[]; splitCents: Map<string, number> }
  | { ok: false; reason: string };

export async function computeJobTipSplit(client: Client, jobId: string, totalAmountCents: number): Promise<TipSplitResult> {
  const job = await client.job.findUnique({ where: { id: jobId } });
  if (!job) return { ok: false, reason: "Job not found." };
  if (job.status !== "COMPLETED" || job.paymentStatus !== "CAPTURED") {
    return { ok: false, reason: "Tips can only be added after the job is completed and payment is captured." };
  }

  const approvedAssignments = await client.assignment.findMany({
    where: { jobId, status: "APPROVED" },
    orderBy: { workerId: "asc" },
  });
  if (approvedAssignments.length === 0) {
    return { ok: false, reason: "No approved workers found for this job." };
  }

  const workerIds = approvedAssignments.map((a) => a.workerId);
  const baseShare = Math.floor(totalAmountCents / workerIds.length);
  const remainder = totalAmountCents - baseShare * workerIds.length;
  const splitCents = new Map<string, number>();
  workerIds.forEach((workerId, i) => {
    splitCents.set(workerId, baseShare + (i === 0 ? remainder : 0));
  });

  return { ok: true, workerIds, splitCents };
}

/**
 * Freight equivalent — a load has exactly one assigned driver, so this
 * is a validation-only counterpart to computeJobTipSplit rather than a
 * real split; kept as its own function (not a shared generic) since the
 * eligibility statuses genuinely differ between jobs and loads.
 */
export async function computeLoadTipRecipient(client: Client, loadId: string): Promise<{ ok: true; workerId: string } | { ok: false; reason: string }> {
  const load = await client.carrierRoute.findUnique({ where: { id: loadId } });
  if (!load) return { ok: false, reason: "Load not found." };
  if (!["DELIVERED", "POD_UPLOADED", "SETTLED"].includes(load.status) || load.paymentStatus !== "CAPTURED") {
    return { ok: false, reason: "Tips can only be added after the load is delivered and payment is captured." };
  }
  if (!load.assignedWorkerId) return { ok: false, reason: "No assigned driver found for this load." };
  return { ok: true, workerId: load.assignedWorkerId };
}

/**
 * The full "attempt to allocate a successfully-paid tip to its
 * worker(s)" operation — computes the split, then creates every
 * TipAllocation and marks the Tip SUCCEEDED inside one transaction, so
 * either both happen or neither does. Shared by the webhook's
 * payment_intent.succeeded handler and the admin recovery route
 * (POST /api/admin/tips/[tipId]/retry-allocation) specifically so the
 * two can't implement this atomicity differently — a review found the
 * original implementation marked SUCCEEDED before allocation was even
 * attempted, which is exactly the class of bug a shared function
 * closes off for good rather than just fixing once.
 *
 * Deliberately does NOT send notifications — that's an external side
 * effect with no business inside (or immediately coupled to) a
 * database transaction; callers read back the created allocations and
 * notify afterward.
 */
export type TipAllocationAttemptResult =
  | { ok: true; allocationIds: string[] }
  | { ok: false; reason: string; recoverable: boolean };

export async function attemptTipAllocation(tipId: string): Promise<TipAllocationAttemptResult> {
  const tip = await prisma.tip.findUnique({ where: { id: tipId } });
  if (!tip) return { ok: false, reason: "Tip not found.", recoverable: false };
  if (tip.status === "SUCCEEDED") return { ok: false, reason: "Already allocated.", recoverable: false };
  if (tip.status !== "PROCESSING" && tip.status !== "PAID_UNALLOCATED") {
    return { ok: false, reason: `Tip status ${tip.status} is not eligible for allocation.`, recoverable: false };
  }

  let splitCents: Map<string, number> | null = null;
  let splitFailureReason = "";
  if (tip.jobId) {
    const result = await computeJobTipSplit(prisma, tip.jobId, tip.amountCents);
    if (result.ok) splitCents = result.splitCents;
    else splitFailureReason = result.reason;
  } else if (tip.loadId) {
    const result = await computeLoadTipRecipient(prisma, tip.loadId);
    if (result.ok) splitCents = new Map([[result.workerId, tip.amountCents]]);
    else splitFailureReason = result.reason;
  } else {
    splitFailureReason = "Tip has neither jobId nor loadId.";
  }

  if (!splitCents) {
    await prisma.tip.update({ where: { id: tip.id }, data: { status: "PAID_UNALLOCATED", succeededAt: tip.succeededAt ?? new Date(), failureReason: splitFailureReason } });
    return { ok: false, reason: splitFailureReason, recoverable: true };
  }

  const confirmedSplitCents = splitCents;
  try {
    const allocationIds: string[] = [];
    await prisma.$transaction(async (tx) => {
      for (const [workerId, amountCents] of confirmedSplitCents) {
        const allocation = await tx.tipAllocation.create({ data: { tipId: tip.id, workerId, amountCents, status: "PENDING" } });
        allocationIds.push(allocation.id);
      }
      await tx.tip.update({ where: { id: tip.id }, data: { status: "SUCCEEDED", succeededAt: tip.succeededAt ?? new Date() } });
    });
    return { ok: true, allocationIds };
  } catch (error) {
    const failureReason = error instanceof Error ? error.message : "Allocation transaction failed.";
    await prisma.tip.update({ where: { id: tip.id }, data: { status: "PAID_UNALLOCATED", succeededAt: tip.succeededAt ?? new Date(), failureReason } });
    return { ok: false, reason: failureReason, recoverable: true };
  }
}

