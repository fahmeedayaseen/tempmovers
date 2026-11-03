import {
  JUNK_VOLUME_TIERS,
  type JunkSpecialItemCode,
  type JunkVolumeTierCode,
} from "@/lib/junk/pricing";

// ---------------------------------------------------------------------------
// Junk allocation — MODEL B (all-inclusive). Rewritten 2 Nov 2026.
//
// Implements TempMovers_Model_B_Final_Developer_Handoff v2.0 + the disposal
// addendum. Pure functions, integer cents, rates in basis points.
//
//   P  = the one flat, all-inclusive customer price (what the customer sees)
//   F  = round(P × feeBps)                 platform commission, on the FULL price
//   H  = Σ helper comp                      helpers, 0..maxHelpers, baked into P
//   R  = P − F − H                          hauler residual
//   The hauler pays actual disposal + operating costs out of R.
//
// Disposal is an INTERNAL ESTIMATE only — a pricing input used to set P with
// headroom and to enforce the hauler floor. It is NEVER a customer line, NEVER
// reimbursed to the hauler, and NEVER auto-refunded. (This replaces the old
// carve-out model, which did `subtotal = allIn − disposal` and reimbursed the
// hauler — see the handoff spec §3.)
//
// Additional helpers (beyond `includedHelperCount`) raise the price through a
// gross-up so the hauler's share is never reduced by adding helpers. A quote
// that would leave the hauler under the earnings floor — after disposal and the
// truck allowance — is repriced up, never accepted underfunded (handoff §2).
//
// Commercial values here are defaults/proposals until Carl approves them.
// ---------------------------------------------------------------------------

export type JunkAllocationPolicy = {
  platformFeeBps: number;
  helperHourlyCents: number;
  helperMinimumMinutes: number;
  helperIncrementMinutes: number;
  haulerFloorCents: number;
  truckAllowanceCents: number;
  /** Max additional helpers a customer may select (handoff §1). */
  maxHelpers: number;
  /** Helpers whose pay is already baked into the base tier price; extras are grossed up. Default 0 = base price is a solo-hauler price and every helper is grossed in. */
  includedHelperCount: number;
  disposalEstimatesCents: Record<JunkVolumeTierCode, number>;
  disposalAddersCents: Record<JunkSpecialItemCode, number>;
};

export const DEFAULT_JUNK_ALLOCATION_POLICY: JunkAllocationPolicy = {
  platformFeeBps: 3000,
  helperHourlyCents: 3000,
  helperMinimumMinutes: 120,
  helperIncrementMinutes: 15,
  haulerFloorCents: 4000,
  truckAllowanceCents: 1000,
  maxHelpers: 10,
  includedHelperCount: 0,
  disposalEstimatesCents: { SINGLE_ITEM: 1500, EIGHTH: 2500, QUARTER: 4000, HALF: 8000, THREE_QUARTER: 10500, FULL: 13500 },
  disposalAddersCents: { MATTRESS: 2500, TIRES: 1000, LARGE_APPLIANCE: 1500, EWASTE: 1000, PIANO: 0, HOT_TUB: 0, FREON_APPLIANCE: 2000 },
};

export class JunkAllocationError extends Error {}

function assertCents(name: string, v: number) {
  if (typeof v !== "number" || Number.isNaN(v)) throw new JunkAllocationError(`${name} must be a number.`);
  if (!Number.isInteger(v)) throw new JunkAllocationError(`${name} must be whole cents.`);
  if (!Number.isSafeInteger(v)) throw new JunkAllocationError(`${name} is out of safe-integer range.`);
  if (v < 0) throw new JunkAllocationError(`${name} must not be negative.`);
}

function assertFeeBps(feeBps: number) {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps >= 10000)
    throw new JunkAllocationError("platformFeeBps must be an integer in [0, 10000).");
}

/** Platform fee on an amount, rounded once, half up, in integer arithmetic. In Model B this is called with the FULL price. */
export function junkPlatformFeeCents(amountCents: number, feeBps: number): number {
  assertCents("amount", amountCents);
  assertFeeBps(feeBps);
  if (amountCents === 0) return 0;
  return Math.floor((amountCents * feeBps + 5000) / 10000);
}

/** Smallest price increase whose amount, after the platform fee, nets at least `netCents`. */
export function grossUpCents(netCents: number, feeBps: number): number {
  assertFeeBps(feeBps);
  if (netCents <= 0) return 0;
  if (!Number.isSafeInteger(netCents)) throw new JunkAllocationError("netCents is out of safe-integer range.");
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
// Crew plan and internal disposal estimate
// ---------------------------------------------------------------------------

export type JunkCrewPlan = {
  helperCount: number;
  jobMinutes: number;
  /** Planned payable time per helper, in seat order. */
  helperMinutes: number[];
};

/**
 * Plan 0..maxHelpers helpers. Each helper is planned for the job's estimated
 * time (safe, never underpays). NOTE (tunable): a crew-speedup model for large
 * crews can be added later; by default each helper is planned for the full job
 * time so no helper is ever underpaid. Helper count is clamped to 0..maxHelpers
 * — it is never silently doubled (handoff §2).
 */
export function planJunkCrew(input: { helperCount: number; estimatedHours: number }, policy: Pick<JunkAllocationPolicy, "helperIncrementMinutes" | "maxHelpers">): JunkCrewPlan {
  // VALIDATE, don't silently clamp (review §4 HIGH): reject non-integer, negative
  // and > maxHelpers counts so a caller never quietly gets a different crew.
  if (!Number.isInteger(input.helperCount) || input.helperCount < 0)
    throw new JunkAllocationError("Helper count must be a whole number of 0 or more.");
  if (input.helperCount > policy.maxHelpers)
    throw new JunkAllocationError(`Helper count may not exceed ${policy.maxHelpers}.`);
  if (!Number.isFinite(input.estimatedHours) || input.estimatedHours < 0)
    throw new JunkAllocationError("Estimated hours must be a finite, non-negative number.");
  const jobMinutes = roundUpToIncrement(Math.round(input.estimatedHours * 60), policy.helperIncrementMinutes);
  const helperCount = input.helperCount;
  return { helperCount, jobMinutes, helperMinutes: Array.from({ length: helperCount }, () => jobMinutes) };
}

/**
 * INTERNAL disposal estimate, scaled by load tier plus special-item adders.
 * A pricing input only — never shown to the customer, never reimbursed,
 * never refunded (addendum A1/A2). `sizeRank` is the tier index.
 *
 * NOTE (addendum A2): extend this to factor estimated WEIGHT and a per-market
 * LOCAL DISPOSAL RATE. The tier/adder baseline below is the floor.
 */
export function estimateDisposalCents(input: { sizeRank: number; specialItems: JunkSpecialItemCode[] }, policy: Pick<JunkAllocationPolicy, "disposalEstimatesCents" | "disposalAddersCents">): number {
  const rank = Math.max(0, Math.min(JUNK_VOLUME_TIERS.length - 1, input.sizeRank));
  const tier = JUNK_VOLUME_TIERS[rank];
  let cents = policy.disposalEstimatesCents[tier] ?? 0;
  for (const code of new Set(input.specialItems)) cents += policy.disposalAddersCents[code] ?? 0;
  return cents;
}

// ---------------------------------------------------------------------------
// Allocation of a given price (Model B)
// ---------------------------------------------------------------------------

export type JunkAllocation = {
  /** The one flat all-inclusive customer price (P). */
  allInCents: number;
  /** Internal disposal estimate (informational; not a ledger allocation). */
  disposalEstimateCents: number;
  platformFeeCents: number;
  helperCompCents: number[];
  helperTotalCents: number;
  /** Hauler residual R = P − F − H. The hauler pays disposal + truck from this. */
  haulerServiceCents: number;
  /** Informational: R − internal disposal estimate (what the hauler nets after disposal, before truck). */
  haulerAfterDisposalCents: number;
  /** What actually transfers to the hauler = R. No disposal reimbursement is added (Model B). */
  haulerTransferCents: number;
};

/** Model B waterfall: fee on the FULL price, hauler = price − fee − helpers. */
export function allocateJunk(input: { allInCents: number; helperCompCents: number[]; platformFeeBps: number; disposalEstimateCents: number }): JunkAllocation {
  assertCents("all-in price", input.allInCents);
  assertCents("disposal estimate", input.disposalEstimateCents);
  input.helperCompCents.forEach((c) => assertCents("helper pay", c));
  const platformFeeCents = junkPlatformFeeCents(input.allInCents, input.platformFeeBps); // FULL price, not price−disposal
  const helperTotalCents = input.helperCompCents.reduce((a, b) => a + b, 0);
  const haulerServiceCents = input.allInCents - platformFeeCents - helperTotalCents;
  return {
    allInCents: input.allInCents,
    disposalEstimateCents: input.disposalEstimateCents,
    platformFeeCents,
    helperCompCents: [...input.helperCompCents],
    helperTotalCents,
    haulerServiceCents,
    haulerAfterDisposalCents: haulerServiceCents - input.disposalEstimateCents,
    haulerTransferCents: haulerServiceCents, // hauler covers disposal from this; nothing added back
  };
}

// ---------------------------------------------------------------------------
// Quote: additional-helper gross-up and the hauler earnings floor
// ---------------------------------------------------------------------------

export type JunkAllocationQuote = JunkAllocation & {
  basePriceCents: number;
  helperGrossUpCents: number;
  floorAdjustmentCents: number;
  repriced: boolean;
  crew: JunkCrewPlan;
  helperPayableMinutes: number[];
  bookingProtectionCents: number;
  totalCents: number;
  lines: { label: string; cents: number }[];
};

export function quoteJunkAllocation(input: {
  basePriceCents: number;
  disposalEstimateCents: number;
  crew: JunkCrewPlan;
  bookingProtectionCents: number;
  policy: JunkAllocationPolicy;
}): JunkAllocationQuote {
  const { policy, crew } = input;
  assertCents("base price", input.basePriceCents);
  const payable = crew.helperMinutes.map((m) => helperPayableMinutes(m, policy));
  const helperComp = payable.map((m) => helperCompCents(m, policy));
  const helperTotal = helperComp.reduce((a, b) => a + b, 0);
  const lines: { label: string; cents: number }[] = [];

  let allIn = input.basePriceCents;

  // Helpers beyond includedHelperCount are grossed into the price so the
  // hauler's share is never reduced by adding helpers (handoff §2, no doubling).
  const included = Math.max(0, Math.min(crew.helperCount, policy.includedHelperCount));
  const includedComp = helperComp.slice(0, included).reduce((a, b) => a + b, 0);
  const extraComp = helperTotal - includedComp;
  const helperGrossUpCents = grossUpCents(extraComp, policy.platformFeeBps);
  if (helperGrossUpCents > 0) {
    allIn += helperGrossUpCents;
    lines.push({ label: "Additional helpers", cents: helperGrossUpCents });
  }

  // Hauler earnings floor, AFTER disposal and the truck allowance (handoff §2).
  const target = policy.haulerFloorCents + policy.truckAllowanceCents + input.disposalEstimateCents;
  const haulerAt = (price: number) =>
    allocateJunk({ allInCents: price, helperCompCents: helperComp, platformFeeBps: policy.platformFeeBps, disposalEstimateCents: input.disposalEstimateCents }).haulerServiceCents;
  let floorAdjustmentCents = 0;
  if (haulerAt(allIn) < target) {
    let price = grossUpCents(target + helperTotal, policy.platformFeeBps);
    if (price < allIn) price = allIn;
    for (let i = 0; i < 10 && haulerAt(price) < target; i++) price += 1;
    for (let i = 0; i < 10 && price - 1 >= allIn && haulerAt(price - 1) >= target; i++) price -= 1;
    floorAdjustmentCents = price - allIn;
    allIn = price;
    if (floorAdjustmentCents > 0) lines.push({ label: "Crew and truck minimum", cents: floorAdjustmentCents });
  }

  const allocation = allocateJunk({ allInCents: allIn, helperCompCents: helperComp, platformFeeBps: policy.platformFeeBps, disposalEstimateCents: input.disposalEstimateCents });
  return {
    ...allocation,
    basePriceCents: input.basePriceCents,
    helperGrossUpCents,
    floorAdjustmentCents,
    repriced: floorAdjustmentCents > 0,
    crew,
    helperPayableMinutes: payable,
    bookingProtectionCents: input.bookingProtectionCents,
    totalCents: allIn + input.bookingProtectionCents,
    lines,
  };
}

// ---------------------------------------------------------------------------
// Settlement at completion (Model B)
// ---------------------------------------------------------------------------

export type JunkSettlementInput = {
  /** The flat all-inclusive price that was funded (quote price + any paid change orders). */
  fundedAllInCents: number;
  /** Actual check-in-to-release minutes for each helper who worked. */
  actualHelperMinutes: number[];
  /** Actual documented disposal cost from the receipt — ADMIN/MARGIN REPORTING ONLY. Never changes any payout or refund (Model B). */
  actualDisposalCents?: number | null;
  bookingProtectionCents: number;
  policy: Pick<JunkAllocationPolicy, "platformFeeBps" | "helperHourlyCents" | "helperMinimumMinutes" | "helperIncrementMinutes">;
};

export type JunkSettlement = {
  collectedCents: number;
  helperPayableMinutes: number[];
  helperCompCents: number[];
  helperTotalCents: number;
  platformFeeCents: number;
  haulerServiceCents: number;
  haulerShortfallCents: number;
  platformNetCents: number;
  /** True when the booking is underfunded (actual helper pay exceeds the whole funded price): NO rows are released; resolve funding/liability first (review §4 BLOCKER). */
  requiresHold: boolean;
  /** When held, how many cents of helper pay the collected funds cannot cover. */
  unfundedObligationCents: number;
  /** Informational only — not a payout or refund. */
  actualDisposalCents: number | null;
  exceptions: string[];
  /** Allocation rows; when not held they are all non-negative and sum to collectedCents. No DISPOSAL or routine CUSTOMER_REFUND row in Model B. When requiresHold, rows is empty (nothing released). */
  rows: { recipient: "PLATFORM" | "PROTECTION" | "HAULER" | "HELPER"; amountCents: number; helperIndex?: number }[];
};

/**
 * Model B settlement. The customer paid a flat price; there is NO disposal
 * reimbursement and NO routine refund. Helpers are paid for actual time worked;
 * the hauler takes the residual (more if the crew finished fast, less if slow,
 * held at zero with an exception if it would go negative). Cancellation /
 * service-failure / legal refunds are handled by a SEPARATE flow, not here.
 */
export function settleJunk(input: JunkSettlementInput): JunkSettlement {
  const { policy } = input;
  assertCents("funded all-in", input.fundedAllInCents);
  assertCents("booking protection", input.bookingProtectionCents);
  const collectedCents = input.fundedAllInCents + input.bookingProtectionCents;
  const exceptions: string[] = [];

  const payable = input.actualHelperMinutes.map((m) => helperPayableMinutes(m, policy));
  const comp = payable.map((m) => helperCompCents(m, policy));
  const helperTotalCents = comp.reduce((a, b) => a + b, 0);

  const platformFeeCents = junkPlatformFeeCents(input.fundedAllInCents, policy.platformFeeBps); // FULL price
  let haulerServiceCents = input.fundedAllInCents - platformFeeCents - helperTotalCents;
  let haulerShortfallCents = 0;

  if (haulerServiceCents < 0) {
    haulerShortfallCents = -haulerServiceCents;
    haulerServiceCents = 0;

    // BLOCKER fix (review §4): if the shortfall exceeds the platform fee, even
    // taking the whole fee can't pay the helpers — the booking is underfunded.
    // Do NOT emit a negative payout row. Hold the release, record the unfunded
    // obligation, and require funding/liability resolution before retry.
    if (haulerShortfallCents > platformFeeCents) {
      const unfundedObligationCents = helperTotalCents - input.fundedAllInCents;
      exceptions.push(
        `Underfunded booking: actual helper pay (${helperTotalCents}¢) exceeds the full funded price (${input.fundedAllInCents}¢). ` +
          `Release HELD — no rows emitted. Fund the ${unfundedObligationCents}¢ shortfall via a change order or the documented exception policy before payout.`,
      );
      return {
        collectedCents,
        helperPayableMinutes: payable,
        helperCompCents: comp,
        helperTotalCents,
        platformFeeCents,
        haulerServiceCents: 0,
        haulerShortfallCents,
        platformNetCents: 0,
        requiresHold: true,
        unfundedObligationCents,
        actualDisposalCents: input.actualDisposalCents ?? null,
        exceptions,
        rows: [],
      };
    }

    // Shortfall fits inside the fee: the platform absorbs it (non-negative), the
    // hauler is held at zero. Settles, but flagged for review.
    exceptions.push(`Hauler earnings would go negative by ${haulerShortfallCents}¢ (actual helper time exceeded what the price supports); held at zero and absorbed from the platform fee pending review.`);
  }

  const platformNetCents = platformFeeCents - haulerShortfallCents; // guaranteed >= 0 here

  const rows: JunkSettlement["rows"] = [
    { recipient: "PLATFORM", amountCents: platformNetCents },
    { recipient: "PROTECTION", amountCents: input.bookingProtectionCents },
    { recipient: "HAULER", amountCents: haulerServiceCents },
    ...comp.map((c, i) => ({ recipient: "HELPER" as const, amountCents: c, helperIndex: i })),
  ];

  // Defense in depth: never release a negative allocation row.
  for (const r of rows) if (r.amountCents < 0) throw new JunkAllocationError(`Refusing to emit a negative allocation row for ${r.recipient}.`);

  const sum = rows.reduce((a, r) => a + r.amountCents, 0);
  if (sum !== collectedCents) throw new JunkAllocationError(`Junk settlement does not balance: ${sum} allocated vs ${collectedCents} collected.`);

  return {
    collectedCents,
    helperPayableMinutes: payable,
    helperCompCents: comp,
    helperTotalCents,
    platformFeeCents,
    haulerServiceCents,
    haulerShortfallCents,
    platformNetCents,
    requiresHold: false,
    unfundedObligationCents: 0,
    actualDisposalCents: input.actualDisposalCents ?? null,
    exceptions,
    rows,
  };
}

// ---------------------------------------------------------------------------
// Crew fulfillment routing (Model B — Item-Pricing & Crew handoff, 2 Nov 2026)
//
// Who supplies the helpers (TempMovers marketplace / the hauler's own approved
// crew / a hybrid) does NOT change the customer price — it changes who the
// helper pool is paid to. This router enforces the financial-safety rules from
// that handoff §4/§8:
//   • each helper slot is paid exactly once, to its approved payee;
//   • a slot that was promised but not supplied-and-verified is NOT paid, and
//     its pay is NEVER redirected into the hauler residual;
//   • if verified attendance doesn't meet the safety-minimum headcount, or any
//     committed slot is unfilled, the whole settlement HOLDS (escalation), it
//     does not auto-settle;
//   • the same negative-row BLOCKER rule as settleJunk applies.
//
// It does NOT decide worker classification, employer/contractor status, tax, or
// Stripe routing/escrow — those are business/legal and must be resolved before
// release (handoff §8). The router only produces who-is-owed-what rows + holds.
// ---------------------------------------------------------------------------

export type CrewSource = "PLATFORM" | "OWN";

/** A helper slot committed at quote time: how it will be supplied and who gets paid. */
export type CommittedCrewSlot = {
  source: CrewSource;
  /** Approved recipient for this slot (marketplace worker account, or an approved hauler-managed payee). Must be set before release. */
  payeeId: string | null;
  /** Whether this slot counts toward the job's safety-required headcount. */
  requiredBySafety: boolean;
};

/** Verified attendance/time for a committed slot at completion. */
export type CrewAttendance = {
  slotIndex: number;
  attended: boolean;
  /** Identity + time verified (photo/check-in/roster match). Unverified is treated as not supplied. */
  verified: boolean;
  actualMinutes: number;
};

export type CrewSettlementRow =
  | { recipient: "PLATFORM" | "PROTECTION" | "HAULER"; amountCents: number }
  | { recipient: "HELPER"; amountCents: number; slotIndex: number; source: CrewSource; payeeId: string };

export type CrewSettlement = {
  collectedCents: number;
  mode: "PLATFORM" | "OWN" | "HYBRID";
  requiredHelperCount: number;
  verifiedHelperCount: number;
  platformFeeCents: number;
  helperPaidCents: number;
  haulerServiceCents: number;
  haulerShortfallCents: number;
  platformNetCents: number;
  requiresHold: boolean;
  unfundedObligationCents: number;
  /** Pay the hauler would have received for missing crew IF it were (wrongly) redirected — always 0 in rows; reported for audit. */
  withheldForUnsuppliedCrewCents: number;
  actualDisposalCents: number | null;
  exceptions: string[];
  rows: CrewSettlementRow[];
};

export function settleJunkCrew(input: {
  fundedAllInCents: number;
  bookingProtectionCents: number;
  committedCrew: CommittedCrewSlot[];
  attendance: CrewAttendance[];
  requiredHelperCount: number;
  actualDisposalCents?: number | null;
  policy: Pick<JunkAllocationPolicy, "platformFeeBps" | "helperHourlyCents" | "helperMinimumMinutes" | "helperIncrementMinutes">;
}): CrewSettlement {
  const { policy } = input;
  assertCents("funded all-in", input.fundedAllInCents);
  assertCents("booking protection", input.bookingProtectionCents);
  const collectedCents = input.fundedAllInCents + input.bookingProtectionCents;
  const exceptions: string[] = [];

  const sources = new Set(input.committedCrew.map((s) => s.source));
  const mode: CrewSettlement["mode"] = input.committedCrew.length === 0 ? "PLATFORM" : sources.size > 1 ? "HYBRID" : (sources.has("OWN") ? "OWN" : "PLATFORM");

  const attByIndex = new Map(input.attendance.map((a) => [a.slotIndex, a]));
  const platformFeeCents = junkPlatformFeeCents(input.fundedAllInCents, policy.platformFeeBps);

  // Which committed slots were actually supplied AND verified.
  const verifiedSlots = input.committedCrew
    .map((slot, i) => ({ slot, i, att: attByIndex.get(i) }))
    .filter((x) => x.att && x.att.attended && x.att.verified);
  const verifiedHelperCount = verifiedSlots.length;

  // Safety / fulfilment gate: every committed slot must be supplied-and-verified,
  // and the verified headcount must meet the safety minimum. Otherwise HOLD.
  const unfilledCommitted = input.committedCrew.length - verifiedHelperCount;
  const belowSafetyMin = verifiedHelperCount < input.requiredHelperCount;
  const missingPayee = verifiedSlots.some((x) => !x.slot.payeeId);

  const mkHold = (reason: string, unfunded = 0): CrewSettlement => {
    exceptions.push(reason);
    return {
      collectedCents, mode, requiredHelperCount: input.requiredHelperCount, verifiedHelperCount,
      platformFeeCents, helperPaidCents: 0, haulerServiceCents: 0, haulerShortfallCents: 0,
      platformNetCents: 0, requiresHold: true, unfundedObligationCents: unfunded,
      withheldForUnsuppliedCrewCents: 0, actualDisposalCents: input.actualDisposalCents ?? null,
      exceptions, rows: [],
    };
  };

  if (unfilledCommitted > 0 || belowSafetyMin) {
    return mkHold(
      `Crew mismatch: ${verifiedHelperCount} of ${input.committedCrew.length} committed helpers supplied & verified; safety minimum is ${input.requiredHelperCount}. ` +
        `Settlement HELD — no automatic pay for unsupplied crew, and no redirection of their pay to the hauler. Escalate for exception/change order.`,
    );
  }
  if (missingPayee) return mkHold("A verified crew slot has no approved payee; settlement HELD until an approved recipient is configured (no payee swaps after funding).");

  // Pay each verified slot once, for its actual payable time, to its payee.
  const helperRows: CrewSettlementRow[] = verifiedSlots.map((x) => {
    const minutes = helperPayableMinutes(x.att!.actualMinutes, policy);
    return { recipient: "HELPER", amountCents: helperCompCents(minutes, policy), slotIndex: x.i, source: x.slot.source, payeeId: x.slot.payeeId! };
  });
  const helperPaidCents = helperRows.reduce((a, r) => a + r.amountCents, 0);

  let haulerServiceCents = input.fundedAllInCents - platformFeeCents - helperPaidCents;
  let haulerShortfallCents = 0;
  if (haulerServiceCents < 0) {
    haulerShortfallCents = -haulerServiceCents;
    haulerServiceCents = 0;
    if (haulerShortfallCents > platformFeeCents) {
      return mkHold(
        `Underfunded: actual helper pay (${helperPaidCents}¢) exceeds the full funded price (${input.fundedAllInCents}¢). Release HELD; fund the shortfall via change order before payout.`,
        helperPaidCents - input.fundedAllInCents,
      );
    }
    exceptions.push(`Hauler earnings held at zero; ${haulerShortfallCents}¢ overrun absorbed from the platform fee pending review.`);
  }
  const platformNetCents = platformFeeCents - haulerShortfallCents;

  const rows: CrewSettlementRow[] = [
    { recipient: "PLATFORM", amountCents: platformNetCents },
    { recipient: "PROTECTION", amountCents: input.bookingProtectionCents },
    { recipient: "HAULER", amountCents: haulerServiceCents },
    ...helperRows,
  ];

  // Safety invariants: no negative rows; each payee+slot once; rows balance.
  for (const r of rows) if (r.amountCents < 0) throw new JunkAllocationError(`Refusing negative crew allocation row for ${r.recipient}.`);
  const slotKeys = helperRows.map((r) => (r as { slotIndex: number }).slotIndex);
  if (new Set(slotKeys).size !== slotKeys.length) throw new JunkAllocationError("Duplicate helper slot allocation detected.");
  const sum = rows.reduce((a, r) => a + r.amountCents, 0);
  if (sum !== collectedCents) throw new JunkAllocationError(`Crew settlement does not balance: ${sum} vs ${collectedCents}.`);

  return {
    collectedCents, mode, requiredHelperCount: input.requiredHelperCount, verifiedHelperCount,
    platformFeeCents, helperPaidCents, haulerServiceCents, haulerShortfallCents, platformNetCents,
    requiresHold: false, unfundedObligationCents: 0, withheldForUnsuppliedCrewCents: 0,
    actualDisposalCents: input.actualDisposalCents ?? null, exceptions, rows,
  };
}
