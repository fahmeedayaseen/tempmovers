import { MARKET_CONFIG, type MarketKey } from "@/config/markets";

/**
 * Resolves which market's badge/backdrop the homepage should show, driven
 * entirely by NEXT_PUBLIC_ACTIVE_MARKET — never hardcoded in the hero
 * component itself. Falls back to Indianapolis (the only currently
 * approved, isActive market) if the env var is missing, misspelled, or
 * points at a market that hasn't been approved for launch yet — this is
 * what keeps an unapproved city from silently going live just because
 * someone set the env var early.
 */
export function getActiveMarket() {
  const requested = (process.env.NEXT_PUBLIC_ACTIVE_MARKET ?? "indianapolis") as MarketKey;
  const configured = MARKET_CONFIG[requested];

  if (!configured || !configured.isActive) {
    return MARKET_CONFIG.indianapolis;
  }

  return configured;
}
