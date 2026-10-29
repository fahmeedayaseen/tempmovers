import {
  JUNK_VOLUME_TIERS,
  type JunkSpecialItemCode,
  type JunkVolumeTierCode,
} from "@/lib/junk/pricing";

// ---------------------------------------------------------------------------
// Junk allocation — VASRUE Digital Media, 29 October 2026.
//
// The full junk crew money model from Carl's payment structure spec §5–§6 and
// junk spec §5a. Pure functions, integer cents, rates in basis points:
//
//   all-in price  − disposal set-aside (no platform cut)  = service subtotal
//   platform fee  = subtotal × fee bps, rounded once
//   helpers       = hourly × payable time, with a minimum and an increment
//   hauler        = subtotal − platform fee − helpers  (+ disposal reimbursement)
//
// A second helper raises the price so the hauler stays whole; a quote that
// would leave the hauler under the earnings floor (after the truck allowance)
// is repriced up, never accepted underpaid. At completion the same rules
// settle the actual hours and the actual dump receipt: unused helper time and
// unused disposal are refunded; anything over the funded scope is never
// silently charged — it shows up as an exception for review.
//
// Every value here is a proposal until Carl approves it (spec §9).
// ---------------------------------------------------------------------------

export type JunkAllocationPolicy = {
  platformFeeBps: number;
  helperHourlyCents: number;
  helperMinimumMinutes: number;
  helperIncrementMinutes: number;
  haulerFloorCents: number;
  truckAllowanceCents: number;
  disposalEstimatesCents: Record<JunkVolumeTierCode, number>;
  disposalAddersCents: Record<JunkSpecialItemCode, number>;
};

/** Starting points from junk spec §5a (midpoints of Carl's ranges); Carl sets the real numbers. */
export const DEFAULT_JUNK_ALLOCATION_POLICY: JunkAllocationPolicy = {
  platformFeeBps: 3000,
  helperHourlyCents: 3000,
  helperMinimumMinutes: 120,
  helperIncrementMinutes: 15,
  haulerFloorCents: 4000,
  truckAllowanceCents: 1000,
  disposalEstimatesCents: { SINGLE_ITEM: 1500, EIGHTH: 2500, QUARTER: 4000, HALF: 8000, THREE_QUARTER: 10500, FULL: 13500 },
  disposalAddersCents: { MATTRESS: 2500, TIRES: 1000, LARGE_APPLIANCE: 1500, EWASTE: 1000, PIANO: 0, HOT_TUB: 0, FREON_APPLIANCE: 2000 },
};

/** Two helpers move a load faster than one: planned time with two is about two thirds. */
export const TWO_HELPER_TIME_FACTOR = { numerator: 2, denominator: 3 } as const;

export class JunkAllocationError extends Error {}

function assertCents(name: string, v: number) {
  if (!Number.isInteger(v)) throw new JunkAllocationError(`${name} must be whole cents.`);
}

/** Platform fee on a service subtotal, rounded once, half up, in integer arithmetic. */
export function junkPlatformFeeCents(subtotalCents: number, feeBps: number): number {
  assertCents("subtotal", subtotalCents);
  if (subtotalCents <= 0) return 0;
  return Math.floor((subtotalCents * feeBps + 5000) / 10000);
}

/** Smallest price increase whose subtotal, after the platform fee, nets at least `netCents`. */
export function grossUpCents(netCents: number, feeBps: number): number {
  if (netCents <= 0) return 0;
  if (feeBps >= 10000) throw new JunkAllocationError("A platform fee of 100% or more leaves nothing to gross up.");
  return Math.ceil((netCents * 10000) / (10000 - feeBps));
}

/** Payable helper minutes: rounded up to the increment, never under the minimum. */
export function helperPayableMinutes(actualMinutes: number, policy: Pick<JunkAllocationPolicy, "helperMinimumMinutes" | "helperIncrementMinutes">): number {
  const inc = Math.max(1, policy.helperIncrementMinutes);
  const rounded = Math.ceil(Math.max(0, actualMinutes) / inc) * inc;
  return Math.max(policy.helperMinimumMinutes, rounded);
}

export function helperCompCents(payableMinutes: number, policy: Pick<JunkAllocationPolicy, "helperHourlyCents">): number {
  return Math.round((policy.helperHourlyCents * payableMinutes) / 60);
}

function roundUpToIncrement(minutes: number, increment: number): number {
  const inc = Math.max(1, increment);
  return Math.ceil(minutes / inc) * inc;
}

// ---------------------------------------------------------------------------
// Crew plan and disposal estimate
// ---------------------------------------------------------------------------

export type JunkCrewPlan = {
  helperCount: number;
  /** Planned job time with the hauler plus one helper (or solo). */
  jobMinutes: number;
  /** Planned payable time per helper, in seat order. */
  helperMinutes: number[];
};

/**
 * Planned time per role. One helper (or a solo hauler) works the job's planned
 * time; with two helpers the job takes about two thirds as long, so each
 * helper is planned for that shorter time (spec §6: size on crew-hours, not
 * headcount).
 */
export function planJunkCrew(input: { helperCount: number; estimatedHours: number }, policy: Pick<JunkAllocationPolicy, "helperIncrementMinutes">): JunkCrewPlan {
  const jobMinutes = roundUpToIncrement(Math.round(input.estimatedHours * 60), policy.helperIncrementMinutes);
  const helperCount = Math.max(0, Math.min(2, Math.floor(input.helperCount)));
  if (helperCount === 2) {
    const each = roundUpToIncrement((jobMinutes * TWO_HELPER_TIME_FACTOR.numerator) / TWO_HELPER_TIME_FACTOR.denominator, policy.helperIncrementMinutes);
    return { helperCount, jobMinutes, helperMinutes: [each, each] };
  }
  return { helperCount, jobMinutes, helperMinutes: helperCount === 1 ? [jobMinutes] : [] };
}

/**
 * Disposal set-aside, scaled by load (junk spec §5a), plus special-item
 * adders. `sizeRank` is the tier index (0 = single item … 5 = full truck).
 */
export function estimateDisposalCents(input: { sizeRank: number; specialItems: JunkSpecialItemCode[] }, policy: Pick<JunkAllocationPolicy, "disposalEstimatesCents" | "disposalAddersCents">): number {
  const rank = Math.max(0, Math.min(JUNK_VOLUME_TIERS.length - 1, input.sizeRank));
  const tier = JUNK_VOLUME_TIERS[rank];
  let cents = policy.disposalEstimatesCents[tier] ?? 0;
  for (const code of new Set(input.specialItems)) cents += policy.disposalAddersCents[code] ?? 0;
  return cents;
}

// ---------------------------------------------------------------------------
// Allocation of a given price
// ---------------------------------------------------------------------------

export type JunkAllocation = {
  allInCents: number;
  disposalCents: number;
  subtotalCents: number;
  platformFeeCents: number;
  helperCompCents: number[];
  helperTotalCents: number;
  haulerServiceCents: number;
  haulerTransferCents: number;
};

/** The waterfall for one all-in price, disposal set-aside and helper pay (payment spec §5). */
export function allocateJunk(input: { allInCents: number; disposalCents: number; helperCompCents: number[]; platformFeeBps: number }): JunkAllocation {
  assertCents("all-in price", input.allInCents);
  assertCents("disposal", input.disposalCents);
  input.helperCompCents.forEach((c) => assertCents("helper pay", c));
  const subtotalCents = input.allInCents - input.disposalCents;
  const platformFeeCents = junkPlatformFeeCents(subtotalCents, input.platformFeeBps);
  const helperTotalCents = input.helperCompCents.reduce((a, b) => a + b, 0);
  const haulerServiceCents = subtotalCents - platformFeeCents - helperTotalCents;
  return {
    allInCents: input.allInCents,
    disposalCents: input.disposalCents,
    subtotalCents,
    platformFeeCents,
    helperCompCents: [...input.helperCompCents],
    helperTotalCents,
    haulerServiceCents,
    haulerTransferCents: haulerServiceCents + input.disposalCents,
  };
}

// ---------------------------------------------------------------------------
// Quote: second-helper rule and the hauler earnings floor
// ---------------------------------------------------------------------------

export type JunkAllocationQuote = JunkAllocation & {
  basePriceCents: number;
  secondHelperAdjustmentCents: number;
  floorAdjustmentCents: number;
  repriced: boolean;
  crew: JunkCrewPlan;
  helperPayableMinutes: number[];
  bookingProtectionCents: number;
  totalCents: number;
  haulerAfterAllowanceCents: number;
  lines: { label: string; cents: number }[];
};

export function quoteJunkAllocation(input: {
  basePriceCents: number;
  disposalCents: number;
  crew: JunkCrewPlan;
  bookingProtectionCents: number;
  policy: JunkAllocationPolicy;
}): JunkAllocationQuote {
  const { policy, crew } = input;
  assertCents("base price", input.basePriceCents);
  const payable = crew.helperMinutes.map((m) => helperPayableMinutes(m, policy));
  const helperComp = payable.map((m) => helperCompCents(m, policy));
  const lines: { label: string; cents: number }[] = [];

  let allIn = input.basePriceCents;

  // Second helper raises the price; it is never carved from the hauler (spec §5).
  let secondHelperAdjustmentCents = 0;
  if (crew.helperCount >= 2) {
    const oneHelperComp = helperCompCents(helperPayableMinutes(crew.jobMinutes, policy), policy);
    const extra = helperComp.reduce((a, b) => a + b, 0) - oneHelperComp;
    secondHelperAdjustmentCents = grossUpCents(extra, policy.platformFeeBps);
    if (secondHelperAdjustmentCents > 0) {
      allIn += secondHelperAdjustmentCents;
      lines.push({ label: "Second helper", cents: secondHelperAdjustmentCents });
    }
  }

  // Hauler earnings floor, after the truck allowance (spec §6). Reprice up.
  const target = policy.haulerFloorCents + policy.truckAllowanceCents;
  const haulerAt = (price: number) => allocateJunk({ allInCents: price, disposalCents: input.disposalCents, helperCompCents: helperComp, platformFeeBps: policy.platformFeeBps }).haulerServiceCents;
  let floorAdjustmentCents = 0;
  if (haulerAt(allIn) < target) {
    const helperTotal = helperComp.reduce((a, b) => a + b, 0);
    let price = input.disposalCents + grossUpCents(target + helperTotal, policy.platformFeeBps);
    if (price < allIn) price = allIn;
    for (let i = 0; i < 10 && haulerAt(price) < target; i++) price += 1;
    // The fee rounds, so the gross-up can overshoot by a cent: take the lowest price that works.
    for (let i = 0; i < 10 && price - 1 >= allIn && haulerAt(price - 1) >= target; i++) price -= 1;
    floorAdjustmentCents = price - allIn;
    allIn = price;
    if (floorAdjustmentCents > 0) lines.push({ label: "Crew and truck minimum", cents: floorAdjustmentCents });
  }

  const allocation = allocateJunk({ allInCents: allIn, disposalCents: input.disposalCents, helperCompCents: helperComp, platformFeeBps: policy.platformFeeBps });
  return {
    ...allocation,
    basePriceCents: input.basePriceCents,
    secondHelperAdjustmentCents,
    floorAdjustmentCents,
    repriced: floorAdjustmentCents > 0,
    crew,
    helperPayableMinutes: payable,
    bookingProtectionCents: input.bookingProtectionCents,
    totalCents: allIn + input.bookingProtectionCents,
    haulerAfterAllowanceCents: allocation.haulerServiceCents - policy.truckAllowanceCents,
    lines,
  };
}

// ---------------------------------------------------------------------------
// Settlement at completion
// ---------------------------------------------------------------------------

export type JunkSettlementInput = {
  /** All-in service price that was funded: quote all-in plus paid non-disposal change orders. */
  fundedAllInCents: number;
  /** Disposal allowance that was funded: quote set-aside plus paid disposal change orders. */
  disposalAllowanceCents: number;
  /** Helper pay the funded scope covers: planned pay plus paid helper/hours change orders. */
  fundedHelperCompCents: number;
  /** Actual check-in-to-release minutes for each helper who worked. */
  actualHelperMinutes: number[];
  /** Approved disposal amount from the receipt, or null while the receipt is missing or under review. */
  approvedDisposalCents: number | null;
  bookingProtectionCents: number;
  policy: Pick<JunkAllocationPolicy, "platformFeeBps" | "helperHourlyCents" | "helperMinimumMinutes" | "helperIncrementMinutes">;
};

export type JunkSettlement = {
  collectedCents: number;
  helperPayableMinutes: number[];
  helperCompCents: number[];
  helperActualTotalCents: number;
  helperChargedCents: number;
  helperUnusedRefundCents: number;
  helperExcessCents: number;
  disposalApproved: boolean;
  disposalReimbursedCents: number;
  disposalRefundCents: number;
  disposalExcessCents: number;
  subtotalCents: number;
  platformFeeCents: number;
  haulerServiceCents: number;
  haulerShortfallCents: number;
  platformNetCents: number;
  refundCents: number;
  exceptions: string[];
  /** Allocation rows; they always sum to collectedCents. */
  rows: { recipient: "PLATFORM" | "PROTECTION" | "HAULER" | "HELPER" | "DISPOSAL" | "CUSTOMER_REFUND"; amountCents: number; helperIndex?: number; held?: boolean }[];
};

export function settleJunk(input: JunkSettlementInput): JunkSettlement {
  const { policy } = input;
  const collectedCents = input.fundedAllInCents + input.bookingProtectionCents;
  const exceptions: string[] = [];

  const payable = input.actualHelperMinutes.map((m) => helperPayableMinutes(m, policy));
  const comp = payable.map((m) => helperCompCents(m, policy));
  const helperActualTotalCents = comp.reduce((a, b) => a + b, 0);
  const helperChargedCents = Math.min(helperActualTotalCents, input.fundedHelperCompCents);
  const helperUnusedRefundCents = Math.max(0, input.fundedHelperCompCents - helperActualTotalCents);
  const helperExcessCents = Math.max(0, helperActualTotalCents - input.fundedHelperCompCents);
  if (helperExcessCents > 0) exceptions.push(`Helper time ran ${helperExcessCents} cents past the funded scope with no paid change order; the helper is paid for the work and the platform carries it pending review.`);

  const disposalApproved = input.approvedDisposalCents !== null;
  let disposalReimbursedCents = input.disposalAllowanceCents;
  let disposalRefundCents = 0;
  let disposalExcessCents = 0;
  if (disposalApproved) {
    const actual = input.approvedDisposalCents as number;
    disposalReimbursedCents = Math.min(actual, input.disposalAllowanceCents);
    disposalRefundCents = Math.max(0, input.disposalAllowanceCents - actual);
    disposalExcessCents = Math.max(0, actual - input.disposalAllowanceCents);
    if (disposalExcessCents > 0) exceptions.push(`Disposal came in ${disposalExcessCents} cents over the funded allowance without a paid change order; reimbursement is capped at the allowance and the difference needs review. The customer is not charged.`);
  } else {
    exceptions.push("Disposal receipt missing or under review; the reimbursement is held.");
  }

  const subtotalCents = input.fundedAllInCents - input.disposalAllowanceCents - helperUnusedRefundCents;
  const platformFeeCents = junkPlatformFeeCents(subtotalCents, policy.platformFeeBps);
  let haulerServiceCents = subtotalCents - platformFeeCents - helperChargedCents;
  let haulerShortfallCents = 0;
  if (haulerServiceCents < 0) {
    haulerShortfallCents = -haulerServiceCents;
    haulerServiceCents = 0;
    exceptions.push(`Hauler earnings would go negative by ${haulerShortfallCents} cents; held at zero and carried by the platform pending review.`);
  }
  const platformNetCents = platformFeeCents - helperExcessCents - haulerShortfallCents;
  const refundCents = helperUnusedRefundCents + disposalRefundCents;

  const rows: JunkSettlement["rows"] = [
    { recipient: "PLATFORM", amountCents: platformNetCents },
    { recipient: "PROTECTION", amountCents: input.bookingProtectionCents },
    { recipient: "HAULER", amountCents: haulerServiceCents },
    ...comp.map((c, i) => ({ recipient: "HELPER" as const, amountCents: c, helperIndex: i })),
    { recipient: "DISPOSAL", amountCents: disposalReimbursedCents, held: !disposalApproved },
  ];
  if (refundCents > 0) rows.push({ recipient: "CUSTOMER_REFUND", amountCents: refundCents });

  const sum = rows.reduce((a, r) => a + r.amountCents, 0);
  if (sum !== collectedCents) throw new JunkAllocationError(`Junk settlement does not balance: ${sum} allocated vs ${collectedCents} collected.`);

  return {
    collectedCents,
    helperPayableMinutes: payable,
    helperCompCents: comp,
    helperActualTotalCents,
    helperChargedCents,
    helperUnusedRefundCents,
    helperExcessCents,
    disposalApproved,
    disposalReimbursedCents,
    disposalRefundCents,
    disposalExcessCents,
    subtotalCents,
    platformFeeCents,
    haulerServiceCents,
    haulerShortfallCents,
    platformNetCents,
    refundCents,
    exceptions,
    rows,
  };
}
