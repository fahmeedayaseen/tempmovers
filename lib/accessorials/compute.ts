/**
 * Accessorial engine — PURE charge calculator (P0). No DB, no network, so
 * every pricing shape and the platform-share split are fully unit-testable.
 * The DB/resolver layer supplies a frozen pricing config + an apply-time
 * quantity; this returns the three cent amounts. All integer cents; rounding
 * is explicit (round half up via Math.round).
 *
 * Invariant enforced here and asserted by tests:
 *   providerShareCents = customerChargeCents - platformShareCents
 *   platformShareCents <= platformCapCents (when a cap is set)
 *   platformShareCents is clamped to [0, customerChargeCents]
 */
import type { AccessorialPricingShape, PlatformShareMode } from "@prisma/client";

export type AccessorialPricingConfig = {
  pricingShape: AccessorialPricingShape;
  customerRateCents: number;
  platformShareMode: PlatformShareMode;
  platformShareValue: number; // cents (FLAT_CENTS) or percent (PERCENT_OF_CHARGE)
  platformCapCents?: number | null;
};

export type AccessorialApplyInput = {
  // The apply-time quantity, meaning depends on the shape:
  //   FLAT        -> ignored (treated as 1)
  //   PERCENTAGE  -> baseAmountCents (the amount the % applies to)
  //   HOURLY      -> hours (decimal ok)
  //   MILEAGE     -> miles (decimal ok)
  //   PER_ITEM    -> item count (integer)
  //   PER_FLIGHT  -> flight count (integer)
  quantity: number;
};

export type AccessorialCharge = {
  customerChargeCents: number;
  platformShareCents: number;
  providerShareCents: number;
};

function roundCents(n: number): number {
  return Math.round(n);
}

/** Customer-facing charge for a shape + rate + quantity. */
export function customerChargeFor(config: AccessorialPricingConfig, input: AccessorialApplyInput): number {
  const q = input.quantity;
  switch (config.pricingShape) {
    case "FLAT":
      return config.customerRateCents;
    case "PERCENTAGE":
      // customerRateCents is interpreted as a percent for this shape; q is the base.
      return roundCents(q * (config.customerRateCents / 100));
    case "HOURLY":
    case "MILEAGE":
      return roundCents(config.customerRateCents * q);
    case "PER_ITEM":
    case "PER_FLIGHT":
      // Integer count; guard against fractional/negative counts.
      return config.customerRateCents * Math.max(0, Math.floor(q));
    default:
      return 0;
  }
}

/** Platform share of a given customer charge. */
export function platformShareFor(config: AccessorialPricingConfig, customerChargeCents: number): number {
  let share: number;
  if (config.platformShareMode === "FLAT_CENTS") {
    share = config.platformShareValue;
  } else {
    // PERCENT_OF_CHARGE
    share = roundCents(customerChargeCents * (config.platformShareValue / 100));
  }
  if (config.platformCapCents != null) share = Math.min(share, config.platformCapCents);
  // Never negative, never more than the customer paid.
  return Math.max(0, Math.min(share, customerChargeCents));
}

/**
 * Full computation: customer charge, platform share, and the provider's
 * remainder. This is model-agnostic — WHO funds the platform share
 * (customer-on-top vs deducted-from-provider) is decided by the fee-model
 * layer that consumes these numbers, exactly like the base fee. Here we only
 * split the charge into platform vs provider so both models can use it.
 */
export function computeAccessorial(config: AccessorialPricingConfig, input: AccessorialApplyInput): AccessorialCharge {
  const customerChargeCents = Math.max(0, customerChargeFor(config, input));
  const platformShareCents = platformShareFor(config, customerChargeCents);
  const providerShareCents = customerChargeCents - platformShareCents;
  return { customerChargeCents, platformShareCents, providerShareCents };
}

/**
 * Band validation for the ACTIVE rate (used by the admin API before it
 * writes an AccessorialMarketPrice). Returns whether customerRateCents is
 * within [minimumPrice, maximumPrice] when both are present. A privileged
 * override bypasses this at the route layer (with reason + audit) — this
 * pure function only reports the in-band verdict.
 */
export function isRateWithinBand(customerRateCents: number, minimumPrice?: number | null, maximumPrice?: number | null): boolean {
  if (minimumPrice != null && customerRateCents < minimumPrice) return false;
  if (maximumPrice != null && customerRateCents > maximumPrice) return false;
  return true;
}
