import { z } from "zod";
import type { PrismaClient, Prisma } from "@prisma/client";
import { prisma as defaultClient } from "@/lib/db";
import { DEFAULT_JUNK_ALLOCATION_POLICY, type JunkAllocationPolicy } from "@/lib/junk/allocation";
import { JUNK_SPECIAL_ITEM_CODES, JUNK_VOLUME_TIERS } from "@/lib/junk/pricing";

// ---------------------------------------------------------------------------
// Payment policy — VASRUE Digital Media, 29 October 2026.
//
// The policy version stamped on every quote, funding attempt and settlement
// under pay-before-dispatch, and the admin-configurable commercial values
// from the payment spec §9 (junk fee, helper rate and minimum, hauler floor
// and truck allowance, disposal estimates, review window, ACH switch). A
// market's own row wins, then the US-DEFAULT row, then the built-in
// proposals. Every value is a proposal until Carl approves it.
// ---------------------------------------------------------------------------

/** Collect the full approved amount before any dispatch or service start. */
export const PAYMENT_POLICY_VERSION = "PBD-1 (2026-10-29)";
/** Jobs and loads booked before pay-before-dispatch: card authorised, captured after the work. */
export const LEGACY_POLICY_VERSION = "LEGACY authorise-then-capture";

export const DEFAULT_POLICY_MARKET_CODE = "US-DEFAULT";

export type ResolvedPaymentPolicy = JunkAllocationPolicy & {
  marketCode: string;
  disposalAutoApproveCents: number;
  reviewWindowHours: number;
  achEnabled: boolean;
  carlApprovedAt: Date | null;
  source: "market" | "default-row" | "built-in";
};

const cents = z.number().int().min(0).max(1_000_000);

export const paymentPolicyUpdateSchema = z.object({
  marketCode: z.string().min(2).max(40),
  junkPlatformFeeBps: z.number().int().min(0).max(9000).optional(),
  helperHourlyCents: cents.optional(),
  helperMinimumMinutes: z.number().int().min(0).max(600).optional(),
  helperIncrementMinutes: z.number().int().min(1).max(120).optional(),
  haulerFloorCents: cents.optional(),
  truckAllowanceCents: cents.optional(),
  disposalEstimatesCents: z.record(z.enum(JUNK_VOLUME_TIERS), cents).optional(),
  disposalAddersCents: z.record(z.enum(JUNK_SPECIAL_ITEM_CODES), cents).optional(),
  disposalAutoApproveCents: cents.optional(),
  reviewWindowHours: z.number().int().min(1).max(720).optional(),
  achEnabled: z.boolean().optional(),
  markCarlApproved: z.boolean().optional(),
}).strict();

type ConfigRow = Prisma.PaymentPolicyConfigGetPayload<object>;

function mergeRecord<T extends string>(base: Record<T, number>, override: unknown): Record<T, number> {
  if (!override || typeof override !== "object") return { ...base };
  const out = { ...base };
  for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
    if (k in base && typeof v === "number" && Number.isInteger(v) && v >= 0) out[k as T] = v;
  }
  return out;
}

export function resolveFromRow(row: ConfigRow | null, marketCode: string, source: ResolvedPaymentPolicy["source"]): ResolvedPaymentPolicy {
  const d = DEFAULT_JUNK_ALLOCATION_POLICY;
  return {
    marketCode,
    platformFeeBps: row?.junkPlatformFeeBps ?? d.platformFeeBps,
    helperHourlyCents: row?.helperHourlyCents ?? d.helperHourlyCents,
    helperMinimumMinutes: row?.helperMinimumMinutes ?? d.helperMinimumMinutes,
    helperIncrementMinutes: row?.helperIncrementMinutes ?? d.helperIncrementMinutes,
    // Model B: max customer-selectable helpers and how many are already baked
    // into the base tier price (0 = base is a solo price, every helper grossed in).
    // From defaults until the admin-wage migration adds maxHelpers/includedHelperCount
    // columns to PaymentPolicyConfig (see admin-controls slice).
    maxHelpers: d.maxHelpers,
    includedHelperCount: d.includedHelperCount,
    haulerFloorCents: row?.haulerFloorCents ?? d.haulerFloorCents,
    truckAllowanceCents: row?.truckAllowanceCents ?? d.truckAllowanceCents,
    disposalEstimatesCents: mergeRecord(d.disposalEstimatesCents, row?.disposalEstimatesCents),
    disposalAddersCents: mergeRecord(d.disposalAddersCents, row?.disposalAddersCents),
    disposalAutoApproveCents: row?.disposalAutoApproveCents ?? 20000,
    reviewWindowHours: row?.reviewWindowHours ?? 24,
    achEnabled: row?.achEnabled ?? false,
    carlApprovedAt: row?.carlApprovedAt ?? null,
    source,
  };
}

export async function resolvePaymentPolicy(marketCode: string | null | undefined, client: PrismaClient | Prisma.TransactionClient = defaultClient): Promise<ResolvedPaymentPolicy> {
  const code = marketCode || DEFAULT_POLICY_MARKET_CODE;
  const rows = await client.paymentPolicyConfig.findMany({ where: { marketCode: { in: [code, DEFAULT_POLICY_MARKET_CODE] } } });
  const own = rows.find((r) => r.marketCode === code);
  if (own) return resolveFromRow(own, code, "market");
  const fallback = rows.find((r) => r.marketCode === DEFAULT_POLICY_MARKET_CODE);
  if (fallback) return resolveFromRow(fallback, code, "default-row");
  return resolveFromRow(null, code, "built-in");
}

/** The market code a job belongs to, for policy lookups. */
export async function marketCodeForJob(job: { marketId: string | null }, client: PrismaClient | Prisma.TransactionClient = defaultClient): Promise<string | null> {
  if (!job.marketId) return null;
  const market = await client.launchMarket.findUnique({ where: { id: job.marketId }, select: { marketCode: true } });
  return market?.marketCode ?? null;
}
