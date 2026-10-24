import { prisma } from "@/lib/db";
import type { FeeModel } from "@prisma/client";
import {
  SCHEDULED_PLATFORM_FEE_PER_MOVER_HOUR_CENTS, URGENT_PLATFORM_FEE_PER_MOVER_HOUR_CENTS,
  CUSTOMER_BOOKING_PROTECTION_FEE_CENTS, MINIMUM_MOVERS_PER_JOB, MINIMUM_JOB_HOURS,
  BOX_TRUCK_PLATFORM_FEE_PER_HOUR_CENTS, SEMI_PLATFORM_FEE_PERCENT, SEMI_PLATFORM_FEE_CAP_CENTS,
} from "@/lib/pricing";

// The one platform-controlled default until every market has its own
// MarketPricingRule row — movers do not set this, customers do not choose
// it, and it is never read from a client request anywhere.
const DEFAULT_MOVER_HOURLY_RATE_CENTS = 3200;

export type ResolvedPricingRule = {
  moverHourlyRateCents: number;
  scheduledFeeCents: number;
  urgentFeeCents: number;
  bookingProtectionCents: number;
  minimumMovers: number;
  minimumHours: number;
  boxTruckFeeCents: number;
  semiFeePercent: number;
  semiFeeCapCents: number;
  // Configurable fee MODEL per freight service type. Moving labor and local
  // box-truck are always ADD_TO_CUSTOMER (no toggle). Freight loads default
  // to DEDUCT_FROM_PROVIDER so quoted prices match load-board norms.
  semiFeeModel: FeeModel;
  freightBoxTruckFeeModel: FeeModel;
};

/**
 * Resolves the currently-effective pricing rule for a market/territory —
 * this is the ONLY source of truth for a mover's hourly wage rate.
 * Prefers the most specific active rule (territory over market-wide), and
 * falls back to the platform defaults in lib/pricing.ts for any field a
 * matched rule leaves null, or when no rule exists for the market yet.
 *
 * Never accepts a rate from a request body — every caller that needs a
 * mover wage rate, a box-truck fee, or a semi fee percentage should call
 * this, not read a client-supplied field.
 */
export async function resolveActivePricingRule(marketId: string, territoryId?: string | null): Promise<ResolvedPricingRule> {
  const now = new Date();

  const rules = await prisma.marketPricingRule.findMany({
    where: {
      marketId,
      effectiveAt: { lte: now },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    orderBy: { effectiveAt: "desc" },
  });

  // Prefer the most recent rule scoped to this exact territory; fall back
  // to the most recent market-wide rule (territoryId: null) if none matches.
  const territoryRule = territoryId ? rules.find((r) => r.territoryId === territoryId) : undefined;
  const marketWideRule = rules.find((r) => !r.territoryId);
  const rule = territoryRule ?? marketWideRule ?? null;

  return {
    moverHourlyRateCents: rule?.moverHourlyRateCents ?? DEFAULT_MOVER_HOURLY_RATE_CENTS,
    scheduledFeeCents: rule?.scheduledFeeCents ?? SCHEDULED_PLATFORM_FEE_PER_MOVER_HOUR_CENTS,
    urgentFeeCents: rule?.urgentFeeCents ?? URGENT_PLATFORM_FEE_PER_MOVER_HOUR_CENTS,
    bookingProtectionCents: rule?.bookingProtectionCents ?? CUSTOMER_BOOKING_PROTECTION_FEE_CENTS,
    minimumMovers: rule?.minimumMovers ?? MINIMUM_MOVERS_PER_JOB,
    minimumHours: rule?.minimumHours ?? MINIMUM_JOB_HOURS,
    boxTruckFeeCents: rule?.boxTruckFeeCents ?? BOX_TRUCK_PLATFORM_FEE_PER_HOUR_CENTS,
    semiFeePercent: rule?.semiFeePercent ? Number(rule.semiFeePercent) : SEMI_PLATFORM_FEE_PERCENT,
    semiFeeCapCents: rule?.semiFeeCapCents ?? SEMI_PLATFORM_FEE_CAP_CENTS,
    // MarketPricingRule doesn't carry a per-service fee model yet; freight
    // defaults to DEDUCT_FROM_PROVIDER (load-board norm). A market can override
    // via PricingRule.semiFeeModel / freightBoxTruckFeeModel once surfaced
    // through the admin console. Reads are null-safe so existing rows work.
    semiFeeModel: (rule as { semiFeeModel?: FeeModel } | null)?.semiFeeModel ?? "DEDUCT_FROM_PROVIDER",
    freightBoxTruckFeeModel: (rule as { freightBoxTruckFeeModel?: FeeModel } | null)?.freightBoxTruckFeeModel ?? "DEDUCT_FROM_PROVIDER",
  };
}
