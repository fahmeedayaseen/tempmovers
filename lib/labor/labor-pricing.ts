import {
  grossUpCents,
  helperCompCents,
  helperPayableMinutes,
  junkPlatformFeeCents,
  JunkAllocationError,
} from "@/lib/junk/allocation";

// ---------------------------------------------------------------------------
// Labor-only pricing — Model B (owner-approved Option A, 3 Nov 2026).
//
// Helpers booked WITHOUT a hauler, truck or junk service (loading/unloading,
// moving assistance). SEPARATE from junk removal and from the existing
// moving-labor pricing in lib/pricing.ts (which is untouched and preserved
// until the owner approves any change).
//
// Rules (combined handoff §6):
//   * EVERY requested worker is billable — there is NO included helper.
//   * The customer rate per worker-hour already embeds the 30% platform fee:
//     rate = workerHourly / (1 − feeBps), rounded UP to the cent (reuses the
//     verified grossUpCents). At $30/hr and 30% → $42.86/worker-hour.
//   * One all-inclusive price; the 30% is NOT added again at checkout.
//   * Workers are paid their underlying comp ($30/hr); the gross-up funds the
//     platform share, not an extra wage.
//
// Per-service / per-territory configurable; commercial values are proposals
// until approved. Reuses the junk allocation primitives, does not duplicate them.
// ---------------------------------------------------------------------------

export type LaborOnlyPolicy = {
  workerHourlyCents: number;
  platformFeeBps: number;
  minimumMinutes: number;
  incrementMinutes: number;
  maxWorkers: number;
  minWorkers: number;
};

export const DEFAULT_LABOR_ONLY_POLICY: LaborOnlyPolicy = {
  workerHourlyCents: 3000, // $30/hr underlying worker compensation
  platformFeeBps: 3000, // 30%
  minimumMinutes: 120,
  incrementMinutes: 15,
  maxWorkers: 10,
  minWorkers: 1,
};

/** The customer rate per worker-hour: worker comp grossed up for the platform fee, rounded up to the cent. */
export function laborCustomerRatePerHourCents(policy: Pick<LaborOnlyPolicy, "workerHourlyCents" | "platformFeeBps">): number {
  return grossUpCents(policy.workerHourlyCents, policy.platformFeeBps); // $30 / 0.70 → $42.86
}

export type LaborOnlyQuote = {
  workers: number;
  payableMinutes: number;
  customerRatePerHourCents: number;
  perWorkerChargeCents: number;
  allInCents: number;
  lines: { label: string; cents: number }[];
};

/** Quote a labor-only job: every worker billed at the embedded-fee rate × payable hours. */
export function quoteLaborOnly(input: { workers: number; estimatedHours: number }, policy: LaborOnlyPolicy = DEFAULT_LABOR_ONLY_POLICY): LaborOnlyQuote {
  if (!Number.isInteger(input.workers) || input.workers < policy.minWorkers || input.workers > policy.maxWorkers)
    throw new JunkAllocationError(`Worker count must be a whole number between ${policy.minWorkers} and ${policy.maxWorkers}.`);
  if (!Number.isFinite(input.estimatedHours) || input.estimatedHours < 0)
    throw new JunkAllocationError("Estimated hours must be a finite, non-negative number.");
  const rate = laborCustomerRatePerHourCents(policy);
  const payableMinutes = helperPayableMinutes(Math.round(input.estimatedHours * 60), { helperMinimumMinutes: policy.minimumMinutes, helperIncrementMinutes: policy.incrementMinutes });
  const perWorkerChargeCents = Math.ceil((rate * payableMinutes) / 60);
  const allInCents = perWorkerChargeCents * input.workers;
  return {
    workers: input.workers,
    payableMinutes,
    customerRatePerHourCents: rate,
    perWorkerChargeCents,
    allInCents,
    lines: [{ label: `Labor (${input.workers} × ${(payableMinutes / 60).toFixed(2)}h @ ${(rate / 100).toFixed(2)}/hr)`, cents: allInCents }],
  };
}

export type LaborOnlySettlementRow = { recipient: "PLATFORM" | "WORKER"; amountCents: number; payeeId?: string };

export type LaborOnlySettlement = {
  collectedCents: number;
  platformFeeCents: number;
  platformNetCents: number;
  workerCompCents: number;
  remainderCents: number;
  /** True when no payout may release (e.g. a worker's classification verification is incomplete). Rows are empty when held. */
  requiresHold: boolean;
  exceptions: string[];
  rows: LaborOnlySettlementRow[];
};

/**
 * Settle a labor-only job. No hauler/truck: the 70% pool is the workers' pay;
 * the platform keeps the 30% fee plus any rounding remainder (documented).
 * Each worker is paid their underlying comp for actual payable time, to their
 * own approved payee. Rows always reconcile to the collected amount.
 */
export function settleLaborOnly(input: {
  fundedAllInCents: number;
  workers: { payeeId: string; actualMinutes: number; classificationVerified?: boolean }[];
  policy: Pick<LaborOnlyPolicy, "workerHourlyCents" | "platformFeeBps" | "minimumMinutes" | "incrementMinutes">;
}): LaborOnlySettlement {
  const { policy } = input;
  if (!Number.isInteger(input.fundedAllInCents) || input.fundedAllInCents < 0) throw new JunkAllocationError("Funded amount must be whole, non-negative cents.");
  const exceptions: string[] = [];

  // Worker-classification gate (owner decision 3 Nov): no labor-only payout
  // releases where a worker's classification verification is incomplete.
  const unclassified = input.workers.filter((w) => w.classificationVerified !== true).length;
  if (unclassified > 0) {
    return {
      collectedCents: input.fundedAllInCents, platformFeeCents: junkPlatformFeeCents(input.fundedAllInCents, policy.platformFeeBps),
      platformNetCents: 0, workerCompCents: 0, remainderCents: 0, requiresHold: true,
      exceptions: [`${unclassified} labor-only worker(s) lack classification verification; payout HELD until verified.`], rows: [],
    };
  }
  const timePolicy = { helperMinimumMinutes: policy.minimumMinutes, helperIncrementMinutes: policy.incrementMinutes };
  const workerRows: LaborOnlySettlementRow[] = input.workers.map((w) => {
    const minutes = helperPayableMinutes(w.actualMinutes, timePolicy);
    return { recipient: "WORKER", amountCents: helperCompCents(minutes, { helperHourlyCents: policy.workerHourlyCents }), payeeId: w.payeeId };
  });
  const workerCompCents = workerRows.reduce((a, r) => a + r.amountCents, 0);
  const platformFeeCents = junkPlatformFeeCents(input.fundedAllInCents, policy.platformFeeBps); // nominal 30%
  let platformNetCents = input.fundedAllInCents - workerCompCents; // platform keeps the rest (fee + rounding remainder)
  if (platformNetCents < 0) {
    exceptions.push(`Worker pay (${workerCompCents}¢) exceeds the funded amount (${input.fundedAllInCents}¢); settlement needs review.`);
    platformNetCents = 0;
  }
  const remainderCents = platformNetCents - platformFeeCents; // documented rounding remainder retained by the platform
  const rows: LaborOnlySettlementRow[] = [{ recipient: "PLATFORM", amountCents: platformNetCents }, ...workerRows];
  const sum = rows.reduce((a, r) => a + r.amountCents, 0);
  if (sum !== input.fundedAllInCents) throw new JunkAllocationError(`Labor-only settlement does not balance: ${sum} vs ${input.fundedAllInCents}.`);
  return { collectedCents: input.fundedAllInCents, platformFeeCents, platformNetCents, workerCompCents, remainderCents, requiresHold: false, exceptions, rows };
}
