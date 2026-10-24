/**
 * Market-level freight-brokerage gate (launch spec §2).
 *
 * Freight brokerage is allowed for a market ONLY when ALL FOUR hold:
 *   1. Global master brokerage flag ON      (FREIGHT_BROKERAGE_ENABLED)
 *   2. Specific brokerage capability flag ON (per-capability)
 *   3. Market's freightBrokerageEnabled ON
 *   4. User has the required permission
 *
 * Critical invariant: the MARKET setting can NEVER override the GLOBAL
 * compliance flags. A market with freightBrokerageEnabled=true still gets
 * brokerage ONLY if the global master + capability flags are on. This is
 * enforced by requiring the global gate FIRST — the market flag is
 * necessary-but-not-sufficient, never sufficient on its own.
 */
import { isBrokerageCapabilityEnabled, type BrokerageCapability } from "@/lib/compliance/service-separation";

export type MarketBrokerageInput = {
  marketFreightBrokerageEnabled: boolean;
  userHasPermission: boolean;
};

/**
 * Pure combiner: given whether the global capability is enabled (resolved by
 * the caller via isBrokerageCapabilityEnabled) plus the market flag and the
 * user permission, decide if brokerage is allowed. Kept pure so the four-way
 * AND is unit-testable and its precedence is explicit.
 */
export function combineBrokerageConditions(globalCapabilityEnabled: boolean, market: MarketBrokerageInput): boolean {
  // Global gate first and hard: if the global capability is off, NOTHING a
  // market or a permission says can turn brokerage on.
  if (!globalCapabilityEnabled) return false;
  if (!market.marketFreightBrokerageEnabled) return false;
  if (!market.userHasPermission) return false;
  return true;
}

/** Full async check: resolves the global capability, then applies market + permission. Fail-closed. */
export async function isMarketBrokerageAllowed(capability: BrokerageCapability, market: MarketBrokerageInput): Promise<boolean> {
  try {
    const globalCapability = await isBrokerageCapabilityEnabled(capability);
    return combineBrokerageConditions(globalCapability, market);
  } catch {
    return false;
  }
}
