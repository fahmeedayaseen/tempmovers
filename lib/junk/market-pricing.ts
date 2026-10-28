import { prisma } from "@/lib/db";
import { CUSTOMER_BOOKING_PROTECTION_FEE_CENTS } from "@/lib/pricing";
import {
  DEFAULT_JUNK_HELPER_SHARE_PERCENT, DEFAULT_JUNK_TAKE_RATE_PERCENT, resolveJunkPriceTable, type JunkPriceTable,
} from "@/lib/junk/pricing";

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
