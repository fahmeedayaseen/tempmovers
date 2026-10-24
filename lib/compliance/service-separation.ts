/**
 * Service separation & brokerage compliance boundary (launch spec, Phase 1).
 *
 * The platform must clearly separate four service domains so that freight
 * BROKERAGE stays legally walled off until TempMovers' broker authority, bond,
 * insurance, and agreements are confirmed active by management:
 *
 *   1. MOVING_LABOR        — live at launch
 *   2. CARRIER_RECRUITMENT — live at launch (signing carriers, no brokering)
 *   3. DISPATCH_SUPPORT    — live at launch IF DISPATCH_SERVICES_ENABLED
 *   4. FREIGHT_BROKERAGE   — INERT until authority confirmed (flag-gated)
 *
 * This module is the single source of truth for that boundary. Any brokerage
 * capability must call assertBrokerageAllowed()/isBrokerageCapabilityEnabled()
 * before doing anything a broker legally may not do without authority
 * (posting loads as broker, taking a margin, generating rate confirmations,
 * paying carriers as broker, direct-shipper quoting).
 *
 * Design: fail-closed. Brokerage is OFF unless the master flag
 * FREIGHT_BROKERAGE_ENABLED *and* the specific capability flag are both on.
 * Turning the master flag on is a management action gated on real-world
 * authority — the code never flips it automatically.
 */
import { isFeatureEnabled } from "@/lib/feature-flags/gate";

export const SERVICE_DOMAINS = ["MOVING_LABOR", "CARRIER_RECRUITMENT", "DISPATCH_SUPPORT", "FREIGHT_BROKERAGE"] as const;
export type ServiceDomain = (typeof SERVICE_DOMAINS)[number];

/** Domains that operate at launch without broker authority. */
export const LAUNCH_SAFE_DOMAINS: ServiceDomain[] = ["MOVING_LABOR", "CARRIER_RECRUITMENT", "DISPATCH_SUPPORT"];

/** The brokerage capability flags, each gated behind the master switch. */
export const BROKERAGE_CAPABILITY_FLAGS = {
  loadPosting: "LOAD_POSTING_ENABLED",
  carrierLoadAcceptance: "CARRIER_LOAD_ACCEPTANCE_ENABLED",
  directShipperQuoting: "DIRECT_SHIPPER_QUOTING_ENABLED",
  carrierPayments: "CARRIER_PAYMENTS_ENABLED",
  brokerCarrierAgreements: "BROKER_CARRIER_AGREEMENTS_ENABLED",
  rateConfirmationGeneration: "RATE_CONFIRMATION_GENERATION_ENABLED",
} as const;
export type BrokerageCapability = keyof typeof BROKERAGE_CAPABILITY_FLAGS;

export const BROKERAGE_MASTER_FLAG = "FREIGHT_BROKERAGE_ENABLED";

/** Dispatch support is a launch-safe service, gated by its own flag (not the brokerage master). */
export async function isDispatchEnabled(): Promise<boolean> {
  return isFeatureEnabled("DISPATCH_SERVICES_ENABLED");
}

/**
 * True only if the brokerage master flag AND the specific capability flag are
 * both enabled. Fail-closed: any error or missing flag → false.
 */
export async function isBrokerageCapabilityEnabled(capability: BrokerageCapability): Promise<boolean> {
  try {
    const master = await isFeatureEnabled(BROKERAGE_MASTER_FLAG);
    if (!master) return false;
    return await isFeatureEnabled(BROKERAGE_CAPABILITY_FLAGS[capability]);
  } catch {
    return false;
  }
}

export class BrokerageNotAuthorizedError extends Error {
  status = 403;
  constructor(capability: BrokerageCapability) {
    super(`Freight brokerage capability "${capability}" is not active. TempMovers broker authority must be confirmed before this can be enabled.`);
    this.name = "BrokerageNotAuthorizedError";
  }
}

/** Throw if a brokerage capability is used while inactive. Call at the top of any brokerage endpoint. */
export async function assertBrokerageAllowed(capability: BrokerageCapability): Promise<void> {
  if (!(await isBrokerageCapabilityEnabled(capability))) {
    throw new BrokerageNotAuthorizedError(capability);
  }
}

/**
 * Whether TempMovers may PUBLICLY represent itself as an authorized freight
 * broker. Tied to the master flag — until it's on, marketing/UI must not claim
 * broker status (launch spec §"public representation").
 */
export async function mayRepresentAsBroker(): Promise<boolean> {
  try { return await isFeatureEnabled(BROKERAGE_MASTER_FLAG); } catch { return false; }
}
