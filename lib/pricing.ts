export const SCHEDULED_PLATFORM_FEE_PER_MOVER_HOUR_CENTS = 500;
export const URGENT_PLATFORM_FEE_PER_MOVER_HOUR_CENTS = 700;
export const CUSTOMER_BOOKING_PROTECTION_FEE_CENTS = 995;
export const MOVER_MONTHLY_SUBSCRIPTION_CENTS = 1995;
export const DRIVER_BASIC_MONTHLY_CENTS = 2995;
export const OWNER_OPERATOR_PRO_MONTHLY_CENTS = 5995;
export const FLEET_MONTHLY_CENTS = 14900;
export const FLEET_INCLUDED_VEHICLES = 5;
export const ADDITIONAL_FLEET_VEHICLE_MONTHLY_CENTS = 1500;
export const BOX_TRUCK_PLATFORM_FEE_PER_HOUR_CENTS = 500;
export const SEMI_PLATFORM_FEE_PERCENT = 5;
export const SEMI_PLATFORM_FEE_CAP_CENTS = 15000;
export const MINIMUM_JOB_HOURS = 3;
export const MINIMUM_MOVERS_PER_JOB = 2;

export type UrgentFeeMode = "HOURLY_FEE" | "PERCENT_PREMIUM";

/**
 * How a platform fee relates to the customer price and the carrier payout.
 *  - ADD_TO_CUSTOMER: fee is stacked ON TOP. Customer pays gross + fee;
 *    carrier receives the full gross. (Moving labor, local box-truck.)
 *  - DEDUCT_FROM_PROVIDER: the posted number IS the customer price; the fee
 *    comes OUT of it. Customer pays gross; carrier receives gross - fee;
 *    platform keeps the fee. (Freight box-truck loads, semi freight — so
 *    the quoted price matches load-board expectations and stays
 *    competitive, and the carrier sees their net before accepting.)
 * The fee AMOUNT is identical either way; only who absorbs it differs.
 */
export type FeeModel = "ADD_TO_CUSTOMER" | "DEDUCT_FROM_PROVIDER";

export type JobQuoteInput = {
  moverHourlyRateCents: number;
  movers: number;
  estimatedHours: number;
  urgent?: boolean;
  urgentFeeMode?: UrgentFeeMode;
  urgentPremiumPercent?: number;
  includeBookingProtection?: boolean;
};

export function calculateJobQuote(input: JobQuoteInput) {
  const movers = Math.max(MINIMUM_MOVERS_PER_JOB, Math.floor(input.movers));
  const billableHours = Math.max(MINIMUM_JOB_HOURS, input.estimatedHours);
  const manHours = movers * billableHours;
  const laborCents = input.moverHourlyRateCents * manHours;
  const urgentFeeMode = input.urgentFeeMode ?? "HOURLY_FEE";
  const platformFeePerManHourCents = input.urgent && urgentFeeMode === "HOURLY_FEE"
    ? URGENT_PLATFORM_FEE_PER_MOVER_HOUR_CENTS
    : SCHEDULED_PLATFORM_FEE_PER_MOVER_HOUR_CENTS;
  const platformFeeCents = platformFeePerManHourCents * manHours;
  const urgentPremiumCents = input.urgent && urgentFeeMode === "PERCENT_PREMIUM"
    ? Math.round((laborCents + platformFeeCents) * ((input.urgentPremiumPercent ?? 20) / 100))
    : 0;
  const bookingProtectionFeeCents = input.includeBookingProtection === false
    ? 0
    : CUSTOMER_BOOKING_PROTECTION_FEE_CENTS;

  return {
    pricingType: "MOVING_LABOR" as const,
    movers,
    billableHours,
    manHours,
    laborCents,
    platformFeePerManHourCents,
    platformFeeCents,
    urgentFeeMode: input.urgent ? urgentFeeMode : null,
    urgentPremiumCents,
    bookingProtectionFeeCents,
    totalCents: laborCents + platformFeeCents + urgentPremiumCents + bookingProtectionFeeCents,
    moverPayoutPerWorkerCents: input.moverHourlyRateCents * billableHours,
  };
}

export type BoxTruckQuoteInput = {
  driverHourlyRateCents: number;
  estimatedHours: number;
  urgent?: boolean;
  urgentPremiumPercent?: number;
};

/**
 * Legacy/exception path only: driver-only bookings where the CUSTOMER
 * supplies the truck, not an owner-operator being paid for their own
 * vehicle+fuel+insurance+maintenance. Owner-operator box-truck loads
 * should use calculateBoxTruckLoadQuote below — see the pricingModel
 * field on CarrierRoute and the "Freight pricing model" README section.
 */
export function calculateBoxTruckQuote(input: BoxTruckQuoteInput) {
  const billableHours = Math.max(1, input.estimatedHours);
  const driverGrossCents = input.driverHourlyRateCents * billableHours;
  const platformFeeCents = BOX_TRUCK_PLATFORM_FEE_PER_HOUR_CENTS * billableHours;
  const urgentPremiumCents = input.urgent
    ? Math.round((driverGrossCents + platformFeeCents) * ((input.urgentPremiumPercent ?? 20) / 100))
    : 0;
  return {
    pricingType: "BOX_TRUCK_HOURLY" as const,
    billableHours,
    driverGrossCents,
    platformFeeCents,
    urgentPremiumCents,
    totalCents: driverGrossCents + platformFeeCents + urgentPremiumCents,
  };
}

export type BoxTruckLoadQuoteInput = {
  /** In ADD_TO_CUSTOMER: the flat guaranteed amount the owner-operator is
   *  paid; customer pays this + fee. In DEDUCT_FROM_PROVIDER: this is the
   *  posted CUSTOMER price and the payout is this - fee. The field name is
   *  kept for back-compat; feeModel decides which role it plays. */
  driverPayoutCents: number;
  urgent?: boolean;
  urgentPremiumPercent?: number;
  accessorialsCents?: number;
  feeModel?: FeeModel;
};

/**
 * Flat-rate box-truck freight. Two fee models (see FeeModel):
 *  - ADD_TO_CUSTOMER (local moving-style box-truck jobs): driverPayoutCents
 *    is the payout; customer pays payout + fee (+ accessorials/urgent).
 *  - DEDUCT_FROM_PROVIDER (freight/load-board box-truck loads): driverPayoutCents
 *    is the posted customer price; carrier nets that - fee. Matches semi.
 * The 5%-capped fee amount is the same in both; only who absorbs it differs.
 */
export function calculateBoxTruckLoadQuote(input: BoxTruckLoadQuoteInput) {
  const feeModel: FeeModel = input.feeModel ?? "ADD_TO_CUSTOMER";
  const postedCents = input.driverPayoutCents;
  const uncappedFeeCents = Math.round(postedCents * (SEMI_PLATFORM_FEE_PERCENT / 100));
  const platformFeeCents = Math.min(uncappedFeeCents, SEMI_PLATFORM_FEE_CAP_CENTS);
  const accessorialsCents = input.accessorialsCents ?? 0;

  // In the deduct model the carrier's net is posted - fee; in the add model
  // the carrier keeps the full posted amount. Urgent surcharge and
  // accessorials are customer-side add-ons in BOTH models (they raise the
  // customer price and are not carrier fees).
  const carrierBaseCents = feeModel === "ADD_TO_CUSTOMER" ? postedCents : postedCents - platformFeeCents;
  const customerBaseCents = feeModel === "ADD_TO_CUSTOMER" ? postedCents + platformFeeCents : postedCents;
  const urgentSurchargeCents = input.urgent
    ? Math.round(customerBaseCents * ((input.urgentPremiumPercent ?? 20) / 100))
    : 0;

  return {
    pricingType: "BOX_TRUCK_FLAT_RATE" as const,
    feeModel,
    driverPayoutCents: carrierBaseCents,
    platformFeePercent: SEMI_PLATFORM_FEE_PERCENT,
    platformFeeCapCents: SEMI_PLATFORM_FEE_CAP_CENTS,
    platformFeeCents,
    accessorialsCents,
    urgentSurchargeCents,
    customerTotalCents: customerBaseCents + accessorialsCents + urgentSurchargeCents,
    carrierPayoutCents: carrierBaseCents,
    totalCents: customerBaseCents + accessorialsCents + urgentSurchargeCents,
  };
}

export function calculateSemiLoadQuote(routeGrossCents: number, feeModel: FeeModel = "DEDUCT_FROM_PROVIDER") {
  const uncappedFeeCents = Math.round(routeGrossCents * (SEMI_PLATFORM_FEE_PERCENT / 100));
  const platformFeeCents = Math.min(uncappedFeeCents, SEMI_PLATFORM_FEE_CAP_CENTS);
  // ADD_TO_CUSTOMER: customer pays gross + fee, carrier gets full gross.
  // DEDUCT_FROM_PROVIDER: customer pays gross (the posted number), carrier
  // gets gross - fee. routeGrossCents is the posted/customer-facing amount
  // in the deduct model, which is the freight-marketplace default.
  const customerTotalCents = feeModel === "ADD_TO_CUSTOMER" ? routeGrossCents + platformFeeCents : routeGrossCents;
  const carrierPayoutCents = feeModel === "ADD_TO_CUSTOMER" ? routeGrossCents : routeGrossCents - platformFeeCents;
  return {
    pricingType: "SEMI_PERCENTAGE_CAPPED" as const,
    feeModel,
    routeGrossCents,
    platformFeePercent: SEMI_PLATFORM_FEE_PERCENT,
    platformFeeCapCents: SEMI_PLATFORM_FEE_CAP_CENTS,
    platformFeeCents,
    customerTotalCents,
    carrierPayoutCents,
    // Back-compat: totalCents kept as the customer-facing total so existing
    // readers that persist estimatedTotalCents keep working.
    totalCents: customerTotalCents,
  };
}

/**
 * Pure calculation only — deliberately does NOT touch a PaymentIntent or
 * any capture flow. Detention/waiting time is billed separately from the
 * flat rate (business decision), but how it actually gets collected —
 * captured from an authorized buffer, a supplemental PaymentIntent, or
 * invoiced separately — needs a product decision this pass doesn't make.
 * Call this to compute the number; wire it into a capture path only once
 * that decision is made.
 */
export function calculateDetention(input: {
  actualWaitTimeMinutes: number;
  includedMinutes: number;
  hourlyRateCents: number;
}) {
  const excessMinutes = Math.max(0, input.actualWaitTimeMinutes - input.includedMinutes);
  const billableQuarterHours = Math.ceil(excessMinutes / 15);
  const detentionCents = Math.round(billableQuarterHours * (input.hourlyRateCents / 4));

  return { excessMinutes, billableQuarterHours, detentionCents };
}

export function calculateFleetSubscription(vehicleCount: number) {
  const extraVehicles = Math.max(0, Math.floor(vehicleCount) - FLEET_INCLUDED_VEHICLES);
  return {
    includedVehicles: FLEET_INCLUDED_VEHICLES,
    extraVehicles,
    baseCents: FLEET_MONTHLY_CENTS,
    extraVehicleCents: extraVehicles * ADDITIONAL_FLEET_VEHICLE_MONTHLY_CENTS,
    totalMonthlyCents: FLEET_MONTHLY_CENTS + extraVehicles * ADDITIONAL_FLEET_VEHICLE_MONTHLY_CENTS,
  };
}

export function isMoverSubscriptionWaived(completedJobs: number, firstCompletedJobAt?: Date | null) {
  return completedJobs < 1 && !firstCompletedJobAt;
}
