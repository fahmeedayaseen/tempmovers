/**
 * Freight compliance gate (freight phase). ONE helper every freight endpoint
 * calls before doing work. Enforces ALL of: global master flag + capability
 * flag (via assertBrokerageAllowed) + market-level service flag + user
 * permission. Carrier assignment additionally calls getCarrierEligibility —
 * this module deliberately does NOT duplicate eligibility logic; it composes
 * the existing services.
 *
 * Fail-closed: any missing condition throws FreightGateError(403). Because all
 * brokerage flags are OFF in every environment, every freight endpoint is
 * inert until management activates the flags after authority is confirmed.
 */
import { prisma } from "@/lib/db";
import { assertBrokerageAllowed, type BrokerageCapability } from "@/lib/compliance/service-separation";

export class FreightGateError extends Error {
  status = 403;
  constructor(message: string) { super(message); this.name = "FreightGateError"; }
}

const ADMIN_ROLES = ["ADMIN", "FINANCE_ADMIN", "SUPER_ADMIN"];

/**
 * @param capability the brokerage capability the endpoint needs
 * @param userRole   the caller's role (permission check)
 * @param marketId   the load's market — its freightBrokerageEnabled must be on
 */
export async function assertFreightAllowed(params: {
  capability: BrokerageCapability;
  userRole: string;
  marketId?: string | null;
  requireAdmin?: boolean;
}): Promise<void> {
  // 1 + 2. Global master + specific capability flag (throws 403 if off).
  await assertBrokerageAllowed(params.capability);

  // 3. Market-level service flag.
  if (params.marketId) {
    const market = await prisma.launchMarket.findUnique({ where: { id: params.marketId }, select: { freightBrokerageEnabled: true } });
    if (!market || !market.freightBrokerageEnabled) {
      throw new FreightGateError("Freight brokerage is not enabled in this market.");
    }
  } else {
    // No market resolved → cannot authorize a brokered action.
    throw new FreightGateError("A market is required to authorize this freight action.");
  }

  // 4. User permission.
  if (params.requireAdmin && !ADMIN_ROLES.includes(params.userRole)) {
    throw new FreightGateError("You do not have permission for this freight action.");
  }
}
