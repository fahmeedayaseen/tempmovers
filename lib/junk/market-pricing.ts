import { prisma } from "@/lib/db";
import { CUSTOMER_BOOKING_PROTECTION_FEE_CENTS } from "@/lib/pricing";
import {
  DEFAULT_JUNK_HELPER_SHARE_PERCENT, DEFAULT_JUNK_TAKE_RATE_PERCENT, resolveJunkPriceTable, type JunkPriceTable,
} from "@/lib/junk/pricing";
import { resolvePaymentPolicy } from "@/lib/payments/policy";

// ---------------------------------------------------------------------------
// Junk removal — VASRUE Digital Media, 28 October 2026.
//
// Server-side lookups for junk bookings: which market serves a ZIP for junk,
// and that market's junk prices. Prices come from the admin pricing engine
// (PricingRule, keyed by marketCode), falling back to the national
// US-DEFAULT row and then to the spec's defaults in lib/junk/pricing.ts.
// Nothing here ever reads a price from a request.
// ---------------------------------------------------------------------------

export type JunkMarketPricing = {
  table: JunkPriceTable;
  takeRatePercent: number;
  helperSharePercent: number;
  bookingProtectionCents: number;
};

/**
 * A market books junk only when junk is switched on for it AND it is taking
 * customer bookings at all. Either booking flag counts: POST /api/jobs still
 * gates on the legacy publicBookingEnabled, the admin console on
 * customerBookingEnabled.
 */
export async function findJunkMarketForZip(postalCode: string, state?: string) {
  const zip5 = postalCode.slice(0, 5);
  return prisma.launchMarket.findFirst({
    where: {
      zipCodes: { has: zip5 },
      ...(state && { state }),
      junkRemovalEnabled: true,
      OR: [{ publicBookingEnabled: true }, { customerBookingEnabled: true }],
    },
  });
}

// ---------------------------------------------------------------------------
// Market Pricing Intelligence (Phase 1): quote availability gate.
//
// Live junk quoting must not silently fall back to unapproved example amounts
// (directive §5/§94). A quote is issued only when the market has an owner-
// approved payment policy (the Model B commercial values that set the cost
// floor) AND an active price source. Otherwise the request is routed to a
// controlled MANUAL_REVIEW state; a ZIP no market serves is UNAVAILABLE.
// ---------------------------------------------------------------------------

export type JunkAvailability =
  | { state: "AVAILABLE" }
  | { state: "MANUAL_REVIEW"; code: "JUNK_PRICING_UNAPPROVED"; reason: string }
  | { state: "UNAVAILABLE"; code: "JUNK_NOT_AVAILABLE"; reason: string };

/**
 * Pure availability decision (acceptance tests #9, #10; correction BLOCKER 5).
 *
 * Live quoting requires the SPECIFIC market to be owner-approved: a
 * market-specific approved payment policy AND a market-specific active
 * PricingRule. The US-DEFAULT fallback (policy default-row or a US-DEFAULT price
 * rule) deliberately does NOT satisfy this — an unapproved market can never be
 * activated by the default, it is routed to manual review.
 */
export function decideJunkAvailability(input: { marketServesZip: boolean; policyApprovedForMarket: boolean; hasActiveMarketPriceRule: boolean }): JunkAvailability {
  if (!input.marketServesZip)
    return { state: "UNAVAILABLE", code: "JUNK_NOT_AVAILABLE", reason: "Junk removal isn't available in this area yet." };
  if (!input.policyApprovedForMarket || !input.hasActiveMarketPriceRule)
    return {
      state: "MANUAL_REVIEW",
      code: "JUNK_PRICING_UNAPPROVED",
      reason: "Junk pricing for this market hasn't been approved yet, so no automatic quote can be issued. This request needs manual review.",
    };
  return { state: "AVAILABLE" };
}

export async function resolveJunkMarketAvailability(marketCode: string): Promise<JunkAvailability> {
  const [policy, rule] = await Promise.all([
    resolvePaymentPolicy(marketCode),
    // Exact market match only — a US-DEFAULT rule must not activate this market.
    prisma.pricingRule.findFirst({ where: { marketCode, active: true } }),
  ]);
  return decideJunkAvailability({
    marketServesZip: true,
    // Must be this market's OWN approved policy (source "market"), not the
    // default-row fallback, and it must carry an owner approval timestamp.
    policyApprovedForMarket: policy.source === "market" && policy.carlApprovedAt != null,
    hasActiveMarketPriceRule: rule != null,
  });
}

export async function resolveJunkMarketPricing(marketCode: string): Promise<JunkMarketPricing> {
  const rules = await prisma.pricingRule.findMany({
    where: { marketCode: { in: [marketCode, "US-DEFAULT"] }, active: true },
  });
  const rule = rules.find((r) => r.marketCode === marketCode) ?? rules.find((r) => r.marketCode === "US-DEFAULT") ?? null;
  return {
    table: resolveJunkPriceTable(rule?.junkPriceTable ?? null),
    takeRatePercent: rule?.junkTakeRatePercent ?? DEFAULT_JUNK_TAKE_RATE_PERCENT,
    helperSharePercent: rule?.junkHelperSharePercent ?? DEFAULT_JUNK_HELPER_SHARE_PERCENT,
    bookingProtectionCents: rule?.customerBookingProtectionFeeCents ?? CUSTOMER_BOOKING_PROTECTION_FEE_CENTS,
  };
}
