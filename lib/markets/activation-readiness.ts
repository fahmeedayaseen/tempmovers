/**
 * Market activation readiness (launch spec §5). Pure validator: given a
 * market's current configuration + supply counts, returns the list of
 * unmet activation requirements ("blockers"). The admin route uses this to
 * decide whether activation may proceed cleanly or requires an override +
 * reason (which is then audited).
 *
 * Pure and data-driven so the rules are testable and adding a rule is a
 * one-line change. Thresholds come from the market's own targets, not
 * hardcoded, so different markets can require different supply.
 */
export type MarketReadinessInput = {
  hasZipOrBoundary: boolean;
  pricingConfigured: boolean;
  minimumBookingRulesConfigured: boolean;
  atLeastOneServiceEnabled: boolean;
  paymentProcessingAvailable: boolean;
  supportCoverageAssigned: boolean;
  approvedWorkerCount: number;
  requiredWorkerThreshold: number;
  approvedCarrierCount: number;
  requiredCarrierThreshold: number;
  freightServiceRequested: boolean; // does this market intend to offer freight?
  unresolvedLaunchBlockers: number;
};

export type ReadinessResult = {
  ready: boolean;
  blockers: string[];
};

export function evaluateMarketActivationReadiness(input: MarketReadinessInput): ReadinessResult {
  const blockers: string[] = [];

  if (!input.hasZipOrBoundary) blockers.push("No ZIP codes or geographic boundary configured.");
  if (!input.pricingConfigured) blockers.push("Pricing is not configured.");
  if (!input.minimumBookingRulesConfigured) blockers.push("Minimum booking rules are not configured.");
  if (!input.atLeastOneServiceEnabled) blockers.push("No supported service is enabled.");
  if (!input.paymentProcessingAvailable) blockers.push("Payment processing is not available.");
  if (!input.supportCoverageAssigned) blockers.push("Support coverage is not assigned.");
  if (input.approvedWorkerCount < input.requiredWorkerThreshold) {
    blockers.push(`Approved worker supply ${input.approvedWorkerCount} is below the required ${input.requiredWorkerThreshold}.`);
  }
  // Carrier threshold only applies when the market intends to offer freight.
  if (input.freightServiceRequested && input.approvedCarrierCount < input.requiredCarrierThreshold) {
    blockers.push(`Approved carrier supply ${input.approvedCarrierCount} is below the required ${input.requiredCarrierThreshold}.`);
  }
  if (input.unresolvedLaunchBlockers > 0) {
    blockers.push(`${input.unresolvedLaunchBlockers} unresolved launch blocker(s) remain.`);
  }

  return { ready: blockers.length === 0, blockers };
}
