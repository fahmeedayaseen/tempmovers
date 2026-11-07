import {
  junkPriceTableOverrideSchema,
  type JunkVolumeTierCode, type JunkPriceTableOverride, type JunkServiceLevelCode,
} from "@/lib/junk/pricing";

// ---------------------------------------------------------------------------
// Approval path: recommendation -> PricingRule (pure part)
//
// Corrections 1 & 2. These are the pure, DB-free building blocks of price
// approval: the service-level-scoped table write, and the guard that decides
// whether a recommendation may be approved at all. The authenticated,
// transactional, audited DB action lives in lib/junk/approve-recommendation.ts
// and composes these.
//
// A recommendation is a PROPOSAL. It becomes a billable price only when an
// authorised admin approves it and the approved price is written into the
// market's PricingRule — into the slot for its OWN service level, so an Economy
// approval can never overwrite a Full-Service rate (correction 1).
// ---------------------------------------------------------------------------

export class ApprovalError extends Error {
  httpStatus: number;
  constructor(message: string, httpStatus: number) { super(message); this.httpStatus = httpStatus; }
}
/** Backwards-compatible alias kept for existing imports/tests. */
export class RecommendationNotApprovedError extends ApprovalError {
  constructor(message: string) { super(message, 409); }
}
export class ApprovalForbiddenError extends ApprovalError {
  constructor(message = "Not authorised to approve prices.") { super(message, 403); }
}
export class FloorOutOfDateError extends ApprovalError {
  constructor(message: string) { super(message, 409); }
}
export class RecommendationNotFoundError extends ApprovalError {
  constructor(message = "Recommendation not found.") { super(message, 404); }
}
export class ApprovalConflictError extends ApprovalError {
  constructor(message = "This recommendation was already approved or changed.") { super(message, 409); }
}
export class MarketPolicyNotApprovedError extends ApprovalError {
  constructor(message = "This market has no owner-approved payment policy; approve the market's PaymentPolicyConfig before activating prices.") { super(message, 409); }
}

export type RecommendationStatusValue = "PENDING" | "APPROVED" | "REJECTED" | "SUPERSEDED";

export type ApprovableRecommendation = {
  status: RecommendationStatusValue;
  serviceLevel: JunkServiceLevelCode;
  volumeTier: JunkVolumeTierCode;
  recommendedPriceCents: number;
  floorPriceCents: number;
};

/** Parse a stored PricingRule.junkPriceTable (Json) into a typed override, or {} if absent/invalid. */
export function parseJunkPriceTableOverride(stored: unknown): JunkPriceTableOverride {
  if (stored == null) return {};
  const parsed = junkPriceTableOverrideSchema.safeParse(stored);
  return parsed.success ? parsed.data : {};
}

/**
 * Fold an APPROVED recommendation's price into a PricingRule.junkPriceTable
 * override, returning a NEW override (does not mutate the input). The price is
 * written ONLY into serviceLevels[serviceLevel].tiersCents[tier], so Economy and
 * Full-Service rates for the same tier are independent and never overwrite each
 * other (correction 1). Throws unless the recommendation is APPROVED and the
 * price is a positive integer at or above its own floor (defence in depth).
 */
export function applyApprovedRecommendationToTable(
  current: JunkPriceTableOverride,
  rec: ApprovableRecommendation,
): JunkPriceTableOverride {
  if (rec.status !== "APPROVED") {
    throw new RecommendationNotApprovedError(`Refusing to apply a ${rec.status} recommendation. Only an APPROVED recommendation becomes a live price.`);
  }
  if (!Number.isInteger(rec.recommendedPriceCents) || rec.recommendedPriceCents <= 0) {
    throw new RecommendationNotApprovedError("Refusing to apply a non-positive recommended price.");
  }
  if (rec.recommendedPriceCents < rec.floorPriceCents) {
    throw new RecommendationNotApprovedError(`Refusing to apply $${(rec.recommendedPriceCents / 100).toFixed(2)}: below the cost floor $${(rec.floorPriceCents / 100).toFixed(2)}.`);
  }
  const serviceLevels = { ...(current.serviceLevels ?? {}) };
  const slot = serviceLevels[rec.serviceLevel] ?? {};
  serviceLevels[rec.serviceLevel] = {
    ...slot,
    tiersCents: { ...(slot.tiersCents ?? {}), [rec.volumeTier]: rec.recommendedPriceCents },
  };
  return { ...current, serviceLevels };
}

/**
 * Stamp the controlled legacy-approval marker onto a market's override
 * (correction: never assume historical prices were owner-approved). Returns a
 * NEW override; the stamp is the documented approval evidence that lets the
 * top-level legacy prices be read as FULL_SERVICE. Existing booking snapshots
 * are not touched — this only governs NEW quotes.
 */
export function stampLegacyFullServiceApproval(
  current: JunkPriceTableOverride,
  by: { approvedAt: Date; approvedBy: string },
): JunkPriceTableOverride {
  return { ...current, legacyFullServiceApprovedAt: by.approvedAt.toISOString(), legacyFullServiceApprovedBy: by.approvedBy };
}

/**
 * The guard an approval action must pass (correction 2). Pure so every rejection
 * path is unit-testable. Rejects: unauthorised role; any non-PENDING status
 * (stale / superseded / rejected / already-approved); a non-positive price; a
 * price below the CURRENT recomputed floor; and a recommendation whose recorded
 * floor no longer matches the current floor (out of date — regenerate it).
 */
export function assertApprovable(input: {
  actingRole: string;
  approverRoles: readonly string[];
  status: RecommendationStatusValue;
  recommendedPriceCents: number;
  recordedFloorCents: number;
  currentFloorCents: number;
}): void {
  if (!input.approverRoles.includes(input.actingRole)) {
    throw new ApprovalForbiddenError();
  }
  if (input.status !== "PENDING") {
    throw new RecommendationNotApprovedError(`Cannot approve a ${input.status} recommendation; only PENDING recommendations can be approved.`);
  }
  if (!Number.isInteger(input.recommendedPriceCents) || input.recommendedPriceCents <= 0) {
    throw new RecommendationNotApprovedError("Recommended price is not a positive integer.");
  }
  if (input.recommendedPriceCents < input.currentFloorCents) {
    throw new RecommendationNotApprovedError(`Recommended price $${(input.recommendedPriceCents / 100).toFixed(2)} is below the current cost floor $${(input.currentFloorCents / 100).toFixed(2)}.`);
  }
  if (input.recordedFloorCents !== input.currentFloorCents) {
    throw new FloorOutOfDateError(`The cost floor has changed since this recommendation was generated ($${(input.recordedFloorCents / 100).toFixed(2)} → $${(input.currentFloorCents / 100).toFixed(2)}). Regenerate it before approving.`);
  }
}
