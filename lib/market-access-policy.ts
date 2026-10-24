/**
 * Market authorization — PURE decision logic (single source of truth). Given a
 * user's admin assignments and the target market's identity (id, state,
 * parent territory), decides whether access is granted. No DB here, so every
 * scope combination is unit-testable.
 *
 * Scopes (AdminScope):
 *   PLATFORM  — access to everything.
 *   STATE     — access to every market whose state code matches the
 *               assignment's state. (Previously unimplemented; now complete.)
 *   MARKET    — access only to the exact market.
 *   TERRITORY — access only to the exact territory. Does NOT grant access to
 *               the rest of the territory's parent market.
 *
 * The target must describe which market/territory is being accessed; a
 * TERRITORY-scoped request passes its territoryId, others may omit it.
 */
export type AdminScope = "PLATFORM" | "STATE" | "MARKET" | "TERRITORY";

export type Assignment = {
  scope: AdminScope;
  state?: string | null;
  marketId?: string | null;
  territoryId?: string | null;
  active?: boolean;
};

export type MarketTarget = {
  marketId: string;
  state: string; // the market's state code (required on LaunchMarket)
  territoryId?: string | null; // the territory being accessed, if any
};

/** Does a single assignment grant access to the target? */
export function assignmentGrants(a: Assignment, target: MarketTarget): boolean {
  if (a.active === false) return false;
  switch (a.scope) {
    case "PLATFORM":
      return true;
    case "STATE":
      // Case-insensitive state match, guarding null/empty.
      return !!a.state && !!target.state && a.state.toUpperCase() === target.state.toUpperCase();
    case "MARKET":
      return a.marketId != null && a.marketId === target.marketId;
    case "TERRITORY":
      return target.territoryId != null && a.territoryId != null && a.territoryId === target.territoryId;
    default:
      return false;
  }
}

/** Does ANY of the user's assignments grant access to the target? */
export function hasMarketAccess(assignments: Assignment[], target: MarketTarget): boolean {
  return assignments.some((a) => assignmentGrants(a, target));
}
