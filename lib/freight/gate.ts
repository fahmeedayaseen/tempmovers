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
import { assertBrokerageAllowed, BrokerageNotAuthorizedError, type BrokerageCapability } from "@/lib/compliance/service-separation";

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
  // 1 + 2. Global master + specific capability flag.
  //
  // BLOCK-12 — VASRUE Digital Media, 24 October 2026.
  //
  // assertBrokerageAllowed throws BrokerageNotAuthorizedError, NOT
  // FreightGateError. This module's own contract above states that "any missing
  // condition throws FreightGateError(403)", and all nine freight routes were
  // written to that contract: every one of them catches FreightGateError and
  // rethrows anything else. Nothing caught BrokerageNotAuthorizedError, so it
  // escaped as an unhandled exception.
  //
  // The practical effect was that every freight endpoint returned 500 instead
  // of 403 whenever a brokerage capability was off — which is all of the time,
  // since all eight brokerage flags are seeded off and stay off until the DOT
  // authority and BMC-84 bond are confirmed. The gate was blocking correctly;
  // it was simply reporting correct, expected behaviour as a server fault. In
  // production that pages on-call for a working guard.
  //
  // Fixed here rather than in nine route handlers: this is the module whose
  // documented contract was untrue, the routes were all honouring it, and
  // translating once means a future capability check cannot reintroduce the
  // same leak. The message and 403 status are preserved exactly, so the
  // response body the client sees is unchanged.
  //
  // This was the last of the four N1–N11 failures (N10).
  try {
    await assertBrokerageAllowed(params.capability);
  } catch (e) {
    if (e instanceof BrokerageNotAuthorizedError) throw new FreightGateError(e.message);
    throw e;
  }

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
