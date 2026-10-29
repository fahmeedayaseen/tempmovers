import type { AllocationRecipient, AllocationState, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { MINIMUM_JOB_HOURS } from "@/lib/pricing";
import { calculateJobFinalCaptureAmount } from "@/lib/capture-preview";
import { settleJunk } from "@/lib/junk/allocation";
import { JUNK_ALLOCATION_MODEL, type JunkQuotePlan } from "@/lib/junk/full-quote";
import { evaluateFunding } from "@/lib/payments/funding";
import { refundCollectedFunds, type PolicyRefundResult } from "@/lib/payments/refunds";
import { PAYMENT_POLICY_VERSION } from "@/lib/payments/policy";
import { captureIntegrationAlert } from "@/lib/monitoring";

// ---------------------------------------------------------------------------
// Settlement — VASRUE Digital Media, 29 October 2026.
//
// Under pay-before-dispatch the money is already collected, so the end of a
// job is no longer "capture"; it is reconciliation (payment spec §3, §6–§8):
//
//   * moving and other hourly jobs: final amount from the approved hours;
//     anything collected and unused is refunded in full;
//   * junk: the full allocation (lib/junk/allocation.ts) — unused helper time
//     and unused disposal refunded, the hauler and helpers paid, the platform
//     fee on the service subtotal, disposal reimbursed against the receipt.
//
// Every collected cent is written to one PaymentAllocation row, and the rows
// must sum to what was collected before anything is saved. One settlement per
// job (unique key); a second call only retries refunds that did not go
// through. Worker payouts created at approval are PENDING until settlement
// sets their final amount and releases them (SCHEDULED); a disposal
// reimbursement waits for its receipt and is transferred on its own.
// ---------------------------------------------------------------------------

export class SettlementError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}

type Row = { recipient: AllocationRecipient; amountCents: number; workerId?: string | null; assignmentId?: string | null; basis?: Prisma.InputJsonValue; state: AllocationState };

export type SettlementOutcome = {
  alreadySettled: boolean;
  settlementId: string;
  state: "SETTLED" | "EXCEPTION";
  collectedCents: number;
  finalTotalCents: number;
  refundCents: number;
  exceptions: string[];
  refund: PolicyRefundResult | null;
};

/** True when a job was booked under pay-before-dispatch (it has funding attempts). */
export async function isPayBeforeDispatchJob(jobId: string): Promise<boolean> {
  return (await prisma.fundingAttempt.count({ where: { entityType: "JOB", entityId: jobId } })) > 0;
}

async function hasActiveException(jobId: string, kind: "EVIDENCE_WAIVER" | "RECEIPT_WAIVER" | "CREDIT_TERMS") {
  return (await prisma.paymentException.count({ where: { entityType: "JOB", entityId: jobId, kind, revokedAt: null } })) > 0;
}

function sumRows(rows: Row[]) {
  return rows.reduce((a, r) => a + r.amountCents, 0);
}

export async function settleJob(jobId: string, actorUserId: string): Promise<SettlementOutcome> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    include: { assignments: { include: { payout: true } }, junkRemovalDetail: true },
  });
  if (!job) throw new SettlementError("Job not found.", 404);

  const existing = await prisma.paymentSettlement.findUnique({ where: { entityType_entityId: { entityType: "JOB", entityId: jobId } } });
  if (existing) {
    // Idempotent: only finish refunds that did not go through the first time.
    const refundRow = await prisma.paymentAllocation.findFirst({ where: { settlementId: existing.id, recipient: "CUSTOMER_REFUND" } });
    let refund: PolicyRefundResult | null = null;
    if (refundRow && refundRow.state !== "REFUNDED") {
      refund = await refundCollectedFunds({ ref: { type: "JOB", id: jobId }, amountCents: refundRow.amountCents, reason: "Unused prepaid amount returned at settlement", purposeKey: `settlement:${existing.id}`, actorUserId });
      if (refund.refundedCents >= refundRow.amountCents) await prisma.paymentAllocation.update({ where: { id: refundRow.id }, data: { state: "REFUNDED" } });
    }
    return { alreadySettled: true, settlementId: existing.id, state: existing.state, collectedCents: existing.collectedCents, finalTotalCents: existing.finalTotalCents, refundCents: existing.refundCents, exceptions: existing.exceptionReason ? [existing.exceptionReason] : [], refund };
  }

  if (job.status !== "COMPLETED") throw new SettlementError("The job must be completed, with every worker's hours approved, before it is settled.");

  const funding = await evaluateFunding({ type: "JOB", id: jobId }, { refresh: true });
  const creditTerms = funding.label === "CREDIT_TERMS";
  if (!funding.funded) throw new SettlementError(`This job is not funded: ${funding.reasons.join(" ")}`);
  const collectedCents = funding.availableCents;
  const exceptions: string[] = [];
  if (creditTerms) exceptions.push("Settled under an audited credit-terms exception; collect the balance separately.");

  const rows: Row[] = [];
  let finalTotalCents = 0;
  let refundCents = 0;
  let platformFeeCents = 0;
  let feeBasisCents = 0;
  let feeBps: number | null = null;
  let details: Prisma.InputJsonValue = {};

  const billable = job.assignments.filter((a) => a.status === "APPROVED" || a.status === "CHECKED_OUT");

  if (job.type === "JUNK_REMOVAL") {
    // ---- junk: the full allocation -------------------------------------
    const detail = job.junkRemovalDetail;
    if (!detail) throw new SettlementError("This junk removal job is missing its details.");
    const hauler = billable.find((a) => a.junkCrewRole === "HAULER");
    if (!hauler || hauler.status !== "APPROVED") throw new SettlementError("The hauler's check-out must be approved before settlement.");
    const evidenceWaived = await hasActiveException(jobId, "EVIDENCE_WAIVER");
    if (!evidenceWaived && (detail.beforePhotoKeys.length === 0 || detail.afterPhotoKeys.length === 0)) {
      throw new SettlementError("Before and after photos are required before a junk job is settled (or an audited evidence waiver).");
    }

    const quote = await prisma.quoteVersion.findFirst({ where: { entityType: "JOB", entityId: jobId }, orderBy: { version: "desc" } });
    const plan = quote?.plan as unknown as JunkQuotePlan | null;
    if (!plan || plan.model !== JUNK_ALLOCATION_MODEL) throw new SettlementError("This junk job was booked before the full allocation model; settle it through the legacy capture path.");

    const paidOrders = await prisma.changeOrder.findMany({ where: { entityType: "JOB", entityId: jobId, status: "PAID" } });
    let fundedAllIn = plan.allInCents;
    let allowance = plan.disposalCents;
    let fundedHelper = plan.helperTotalCents;
    for (const co of paidOrders) {
      const p = (co.plan ?? {}) as { allInDeltaCents?: number; disposalDeltaCents?: number; helperCompDeltaCents?: number };
      fundedAllIn += p.allInDeltaCents ?? co.deltaCents;
      allowance += p.disposalDeltaCents ?? 0;
      fundedHelper += p.helperCompDeltaCents ?? 0;
    }

    const disposal = await prisma.disposalExpense.findUnique({ where: { jobId } });
    let approvedDisposal: number | null = null;
    if (disposal?.state === "APPROVED") approvedDisposal = disposal.actualCents ?? 0;
    if (disposal?.state === "REJECTED") approvedDisposal = 0;

    const helpers = billable.filter((a) => a.junkCrewRole === "HELPER" && a.status === "APPROVED").sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const result = settleJunk({
      fundedAllInCents: fundedAllIn,
      disposalAllowanceCents: allowance,
      fundedHelperCompCents: fundedHelper,
      actualHelperMinutes: helpers.map((h) => Math.round(Number(h.actualHours ?? 0) * 60)),
      approvedDisposalCents: approvedDisposal,
      bookingProtectionCents: plan.bookingProtectionCents,
      policy: { platformFeeBps: plan.platformFeeBps, helperHourlyCents: plan.helperHourlyCents, helperMinimumMinutes: plan.helperMinimumMinutes, helperIncrementMinutes: plan.helperIncrementMinutes },
    });
    if (!creditTerms && result.collectedCents !== collectedCents) {
      throw new SettlementError(`Collected funds (${collectedCents} cents) do not match the funded scope (${result.collectedCents} cents). Reconcile the payments by hand before settling.`);
    }
    exceptions.push(...result.exceptions);

    for (const r of result.rows) {
      if (r.recipient === "HAULER") rows.push({ recipient: "HAULER", amountCents: r.amountCents, workerId: hauler.workerId, assignmentId: hauler.id, state: "RELEASED", basis: { rule: "subtotal − platform fee − helper pay", subtotalCents: result.subtotalCents, platformFeeCents: result.platformFeeCents, helperChargedCents: result.helperChargedCents } });
      else if (r.recipient === "HELPER") {
        const h = helpers[r.helperIndex ?? 0];
        rows.push({ recipient: "HELPER", amountCents: r.amountCents, workerId: h.workerId, assignmentId: h.id, state: "RELEASED", basis: { rule: "hourly × payable time", hourlyCents: plan.helperHourlyCents, payableMinutes: result.helperPayableMinutes[r.helperIndex ?? 0], minimumMinutes: plan.helperMinimumMinutes, incrementMinutes: plan.helperIncrementMinutes } });
      } else if (r.recipient === "DISPOSAL") rows.push({ recipient: "DISPOSAL", amountCents: r.amountCents, workerId: hauler.workerId, assignmentId: null, state: r.held ? "HELD" : "APPROVED_AWAITING_FUNDS", basis: { allowanceCents: allowance, approvedCents: approvedDisposal, receipt: disposal?.receiptKey ? "on file" : "missing" } });
      else if (r.recipient === "CUSTOMER_REFUND") rows.push({ recipient: "CUSTOMER_REFUND", amountCents: r.amountCents, state: "APPROVED_AWAITING_FUNDS", basis: { unusedHelperCents: result.helperUnusedRefundCents, unusedDisposalCents: result.disposalRefundCents } });
      else if (r.recipient === "PLATFORM") rows.push({ recipient: "PLATFORM", amountCents: r.amountCents, state: "RETAINED", basis: { feeBps: plan.platformFeeBps, feeBasisCents: result.subtotalCents, helperExcessCents: result.helperExcessCents, haulerShortfallCents: result.haulerShortfallCents } });
      else rows.push({ recipient: "PROTECTION", amountCents: r.amountCents, state: "RETAINED" });
    }
    // Helpers who worked but whose seat was never approved are not billable yet.
    refundCents = result.refundCents;
    finalTotalCents = result.collectedCents - result.refundCents;
    platformFeeCents = result.platformFeeCents;
    feeBasisCents = result.subtotalCents;
    feeBps = plan.platformFeeBps;
    details = { model: plan.model, quoteVersion: quote?.version ?? null, paidChangeOrders: paidOrders.map((c) => ({ id: c.id, kind: c.kind, deltaCents: c.deltaCents })), settlement: result as unknown as Prisma.InputJsonValue };
  } else {
    // ---- moving and other hourly services --------------------------------
    const preview = await calculateJobFinalCaptureAmount(prisma, job);
    if (!preview.ok) throw new SettlementError(preview.reason);
    finalTotalCents = preview.finalTotalCents;
    const shortfall = Math.max(0, finalTotalCents - collectedCents);
    refundCents = Math.max(0, collectedCents - finalTotalCents);
    if (shortfall > 0) exceptions.push(`Approved hours came to ${shortfall} cents more than was collected, with no paid extension. Workers are paid for the approved work; the platform carries the difference pending review. The customer is not charged.`);

    for (const a of preview.billableAssignments) {
      const billedHours = Math.max(MINIMUM_JOB_HOURS, Number(a.actualHours));
      rows.push({ recipient: "WORKER", amountCents: Math.round(a.agreedEarningsCents * billedHours), workerId: a.workerId, assignmentId: a.id, state: "RELEASED", basis: { rateCents: a.agreedEarningsCents, billedHours } });
    }
    rows.push({ recipient: "PLATFORM", amountCents: preview.finalPlatformFeeCents + job.urgentPremiumCents - shortfall, state: "RETAINED", basis: { platformFeeCents: preview.finalPlatformFeeCents, urgentPremiumCents: job.urgentPremiumCents, shortfallCents: shortfall } });
    rows.push({ recipient: "PROTECTION", amountCents: job.bookingProtectionFeeCents, state: "RETAINED" });
    if (refundCents > 0) rows.push({ recipient: "CUSTOMER_REFUND", amountCents: refundCents, state: "APPROVED_AWAITING_FUNDS", basis: { rule: "collected − final approved amount" } });
    platformFeeCents = preview.finalPlatformFeeCents;
    feeBasisCents = preview.finalLaborCents;
    details = { finalLaborCents: preview.finalLaborCents, finalPlatformFeeCents: preview.finalPlatformFeeCents, finalTotalCents, shortfallCents: shortfall };
    finalTotalCents = Math.min(finalTotalCents, collectedCents);
  }

  const allocated = sumRows(rows);
  if (!creditTerms && allocated !== collectedCents) {
    captureIntegrationAlert("Settlement did not balance; nothing was written.", { area: "payment", jobId, allocated, collectedCents });
    throw new SettlementError(`Settlement does not balance (${allocated} allocated, ${collectedCents} collected). Nothing was changed.`);
  }

  const state = exceptions.length > 0 && exceptions.some((e) => !e.startsWith("Disposal receipt missing")) ? "EXCEPTION" : "SETTLED";

  const settlement = await prisma.$transaction(async (tx) => {
    const s = await tx.paymentSettlement.create({
      data: {
        entityType: "JOB", entityId: jobId, state, policyVersion: PAYMENT_POLICY_VERSION, collectedCents, finalTotalCents, refundCents,
        platformFeeCents, feeBasisCents, feeBps, exceptionReason: exceptions.length ? exceptions.join(" ") : null, details, settledByUserId: actorUserId,
      },
    });
    for (const r of rows) {
      let payoutId: string | null = null;
      if (r.assignmentId && (r.recipient === "HAULER" || r.recipient === "HELPER" || r.recipient === "WORKER")) {
        const a = job.assignments.find((x) => x.id === r.assignmentId);
        if (a?.payout && ["TRANSFERRED", "PAID_OUT"].includes(a.payout.status)) {
          payoutId = a.payout.id; // already paid under the old flow; leave it alone
        } else if (a?.payout) {
          const p = await tx.payout.update({ where: { id: a.payout.id }, data: { grossEarningsCents: r.amountCents, netPayoutCents: r.amountCents - a.payout.recoveryCents + a.payout.adjustmentsCents, status: r.state === "HELD" ? "HELD" : "SCHEDULED", scheduledAt: new Date() } });
          payoutId = p.id;
        } else if (a && r.amountCents > 0) {
          const p = await tx.payout.create({ data: { workerId: a.workerId, assignmentId: a.id, grossEarningsCents: r.amountCents, netPayoutCents: r.amountCents, status: r.state === "HELD" ? "HELD" : "SCHEDULED", scheduledAt: new Date() } });
          payoutId = p.id;
        }
      }
      await tx.paymentAllocation.create({
        data: { settlementId: s.id, entityType: "JOB", entityId: jobId, recipient: r.recipient, workerId: r.workerId ?? null, assignmentId: r.assignmentId ?? null, payoutId, amountCents: r.amountCents, basis: r.basis, state: r.state },
      });
    }
    await tx.job.update({
      where: { id: jobId },
      data: {
        finalTotalCents, finalPlatformFeeCents: platformFeeCents, capturedAmountCents: collectedCents, capturedAt: job.capturedAt ?? new Date(),
        authorizedAmountCents: job.estimatedTotalCents,
      },
    });
    await tx.auditLog.create({ data: { actorId: actorUserId, jobId, action: "JOB_SETTLED", entityType: "Job", entityId: jobId, details: { settlementId: s.id, state, collectedCents, finalTotalCents, refundCents, exceptions } } });
    return s;
  });

  let refund: PolicyRefundResult | null = null;
  if (refundCents > 0) {
    refund = await refundCollectedFunds({ ref: { type: "JOB", id: jobId }, amountCents: refundCents, reason: "Unused prepaid amount returned at settlement", purposeKey: `settlement:${settlement.id}`, actorUserId });
    if (refund.refundedCents >= refundCents) {
      await prisma.paymentAllocation.updateMany({ where: { settlementId: settlement.id, recipient: "CUSTOMER_REFUND" }, data: { state: "REFUNDED" } });
    }
  }
  if (state === "EXCEPTION") captureIntegrationAlert("A job settled with an exception that needs review.", { area: "payment", jobId, exceptions: exceptions.join(" | ") });

  return { alreadySettled: false, settlementId: settlement.id, state, collectedCents, finalTotalCents, refundCents, exceptions, refund };
}

/**
 * A disposal receipt reviewed after the job was settled: the reimbursement
 * becomes the approved amount (never more than the allowance) and any unused
 * allowance is refunded to the customer in full. The hauler's service
 * earnings and the platform fee do not move — disposal is outside the fee base.
 */
export async function applyDisposalReview(jobId: string, actorUserId: string): Promise<{ refund: PolicyRefundResult | null; reimbursedCents: number } | null> {
  const settlement = await prisma.paymentSettlement.findUnique({ where: { entityType_entityId: { entityType: "JOB", entityId: jobId } } });
  if (!settlement) return null;
  const disposal = await prisma.disposalExpense.findUnique({ where: { jobId } });
  if (!disposal || (disposal.state !== "APPROVED" && disposal.state !== "REJECTED")) return null;
  const row = await prisma.paymentAllocation.findFirst({ where: { settlementId: settlement.id, recipient: "DISPOSAL" } });
  if (!row || row.state === "TRANSFERRED") return null;

  const allowance = row.amountCents;
  const approved = disposal.state === "APPROVED" ? Math.min(disposal.actualCents ?? 0, allowance) : 0;
  const unused = allowance - approved;
  await prisma.$transaction(async (tx) => {
    await tx.paymentAllocation.update({ where: { id: row.id }, data: { amountCents: approved, state: approved > 0 ? "APPROVED_AWAITING_FUNDS" : "REFUNDED", basis: { allowanceCents: allowance, approvedCents: approved, reviewedAt: new Date().toISOString() } } });
    if (unused > 0) {
      await tx.paymentAllocation.create({ data: { settlementId: settlement.id, entityType: "JOB", entityId: jobId, recipient: "CUSTOMER_REFUND", amountCents: unused, state: "APPROVED_AWAITING_FUNDS", basis: { rule: "unused disposal allowance after receipt review" } } });
      await tx.paymentSettlement.update({ where: { id: settlement.id }, data: { refundCents: { increment: unused }, finalTotalCents: { decrement: unused } } });
    }
    await tx.auditLog.create({ data: { actorId: actorUserId, jobId, action: "DISPOSAL_SETTLED", entityType: "Job", entityId: jobId, details: { allowanceCents: allowance, approvedCents: approved, refundCents: unused } } });
  });
  let refund: PolicyRefundResult | null = null;
  if (unused > 0) {
    refund = await refundCollectedFunds({ ref: { type: "JOB", id: jobId }, amountCents: unused, reason: "Unused disposal allowance returned after the dump receipt", purposeKey: `disposal:${disposal.id}`, actorUserId });
    if (refund.refundedCents >= unused) {
      await prisma.paymentAllocation.updateMany({ where: { settlementId: settlement.id, recipient: "CUSTOMER_REFUND", basis: { path: ["rule"], equals: "unused disposal allowance after receipt review" } }, data: { state: "REFUNDED" } });
    }
  }
  return { refund, reimbursedCents: approved };
}

// ---------------------------------------------------------------------------
// Loads: POD acceptance is the release point (payment spec §7). A prepaid load
// was collected when it was posted; accepting its proof of delivery records
// the load's settlement and allocation, and only then does it become eligible
// for the carrier's settlement batch. Timeout never bypasses POD.
// ---------------------------------------------------------------------------

export async function settleLoad(loadId: string, actorUserId: string): Promise<SettlementOutcome> {
  const load = await prisma.carrierRoute.findUnique({ where: { id: loadId } });
  if (!load) throw new SettlementError("Load not found.", 404);
  const existing = await prisma.paymentSettlement.findUnique({ where: { entityType_entityId: { entityType: "LOAD", entityId: loadId } } });
  if (existing) return { alreadySettled: true, settlementId: existing.id, state: existing.state, collectedCents: existing.collectedCents, finalTotalCents: existing.finalTotalCents, refundCents: existing.refundCents, exceptions: [], refund: null };
  if (load.status !== "POD_UPLOADED" || !load.proofOfDeliveryUrl) throw new SettlementError("Proof of delivery must be uploaded before it can be accepted.");

  const funding = await evaluateFunding({ type: "LOAD", id: loadId }, { refresh: true });
  if (!funding.funded) throw new SettlementError(`This load is not funded: ${funding.reasons.join(" ")}`);
  const collected = funding.availableCents;
  const platform = Math.min(load.platformFeeCents, collected);
  const carrier = collected - platform;

  const settlement = await prisma.$transaction(async (tx) => {
    const s = await tx.paymentSettlement.create({
      data: { entityType: "LOAD", entityId: loadId, state: "SETTLED", policyVersion: PAYMENT_POLICY_VERSION, collectedCents: collected, finalTotalCents: collected, platformFeeCents: platform, feeBasisCents: collected, details: { podAcceptedAt: new Date().toISOString(), proofOfDeliveryUrl: "on file" }, settledByUserId: actorUserId },
    });
    await tx.paymentAllocation.create({ data: { settlementId: s.id, entityType: "LOAD", entityId: loadId, recipient: "CARRIER", workerId: load.assignedWorkerId, amountCents: carrier, state: "RELEASED", basis: { rule: "collected − platform fee; paid in the carrier's settlement batch" } } });
    await tx.paymentAllocation.create({ data: { settlementId: s.id, entityType: "LOAD", entityId: loadId, recipient: "PLATFORM", amountCents: platform, state: "RETAINED" } });
    await tx.auditLog.create({ data: { actorId: actorUserId, action: "LOAD_POD_ACCEPTED", entityType: "CarrierRoute", entityId: loadId, details: { settlementId: s.id, collectedCents: collected } } });
    return s;
  });
  return { alreadySettled: false, settlementId: settlement.id, state: "SETTLED", collectedCents: collected, finalTotalCents: collected, refundCents: 0, exceptions: [], refund: null };
}

/**
 * Carrier settlement eligibility: a prepaid load is captured from the start,
 * so "captured" no longer implies "delivered and POD accepted". Prepaid loads
 * qualify only once their POD has been accepted (a LOAD PaymentSettlement).
 */
export async function onlyPodAcceptedLoads<T extends { id: string }>(client: Prisma.TransactionClient | typeof prisma, loads: T[]): Promise<T[]> {
  if (loads.length === 0) return loads;
  const ids = loads.map((l) => l.id);
  const [prepaid, accepted] = await Promise.all([
    client.fundingAttempt.findMany({ where: { entityType: "LOAD", entityId: { in: ids } }, select: { entityId: true } }),
    client.paymentSettlement.findMany({ where: { entityType: "LOAD", entityId: { in: ids } }, select: { entityId: true } }),
  ]);
  const prepaidIds = new Set(prepaid.map((p) => p.entityId));
  const acceptedIds = new Set(accepted.map((a) => a.entityId));
  return loads.filter((l) => !prepaidIds.has(l.id) || acceptedIds.has(l.id));
}
