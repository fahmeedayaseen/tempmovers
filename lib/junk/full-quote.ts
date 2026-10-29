import { calculateJunkQuote, sizeRank, type JunkQuote, type JunkQuoteInput, type JunkQuoteLine } from "@/lib/junk/pricing";
import { estimateDisposalCents, planJunkCrew, quoteJunkAllocation, type JunkAllocationQuote } from "@/lib/junk/allocation";
import { resolveJunkMarketPricing } from "@/lib/junk/market-pricing";
import { PAYMENT_POLICY_VERSION, resolvePaymentPolicy, type ResolvedPaymentPolicy } from "@/lib/payments/policy";
import type { JunkJobDetailsInput } from "@/lib/junk/request-schema";

// ---------------------------------------------------------------------------
// Junk quote under the full allocation model — VASRUE Digital Media, 29 Oct 2026.
//
// Carl's tier and item prices (junk spec §5) set the base all-in price; the
// payment spec §5–§6 then carves out the disposal set-aside, takes the
// platform fee on the service subtotal only, plans hourly helpers, raises the
// price for a second helper and reprices anything that would leave the hauler
// under the earnings floor. The customer sees one total, what it includes,
// and that unused disposal comes back to them. The crew split stays internal
// and is snapshotted onto the booking as the quote's plan.
// ---------------------------------------------------------------------------

export const JUNK_ALLOCATION_MODEL = "JUNK_FULL_ALLOCATION_V1" as const;

export type JunkQuotePlan = {
  model: typeof JUNK_ALLOCATION_MODEL;
  policyVersion: string;
  marketCode: string;
  basePriceCents: number;
  secondHelperAdjustmentCents: number;
  floorAdjustmentCents: number;
  allInCents: number;
  disposalCents: number;
  subtotalCents: number;
  platformFeeBps: number;
  platformFeeCents: number;
  helperHourlyCents: number;
  helperMinimumMinutes: number;
  helperIncrementMinutes: number;
  helperCount: number;
  jobMinutes: number;
  helperMinutes: number[];
  helperPayableMinutes: number[];
  helperCompCents: number[];
  helperTotalCents: number;
  haulerServiceCents: number;
  haulerTransferCents: number;
  haulerFloorCents: number;
  truckAllowanceCents: number;
  bookingProtectionCents: number;
  totalCents: number;
  repriced: boolean;
  policyApprovedByCarl: boolean;
};

export type PublicJunkQuote = {
  pricingMode: JunkQuote["pricingMode"];
  servicePriceCents: number;
  surchargesCents: number;
  allInCents: number;
  helpersRequired: number;
  crewSize: number;
  bookingProtectionFeeCents: number;
  totalCents: number;
  estimatedHours: number;
  /** Lines that add up to the total. */
  lines: JunkQuoteLine[];
  /** What the all-in price includes: service, and the disposal set-aside refunded if unused. */
  serviceCents: number;
  disposalEstimateCents: number;
  /** Helper pay basis, shown to the customer so the crew size is explained. */
  helperHourlyCents: number;
  helperMinimumHours: number;
};

export type JunkFullQuote = {
  base: JunkQuote;
  allocation: JunkAllocationQuote;
  policy: ResolvedPaymentPolicy;
  plan: JunkQuotePlan;
  publicQuote: PublicJunkQuote;
};

export function buildJunkFullQuote(input: JunkQuoteInput, policy: ResolvedPaymentPolicy): JunkFullQuote {
  // The base price, crew size and hours come from Carl's tables, unchanged.
  const base = calculateJunkQuote(input);
  const disposalCents = estimateDisposalCents({ sizeRank: sizeRank(input), specialItems: input.specialItems }, policy);
  const crew = planJunkCrew({ helperCount: base.helpersRequired, estimatedHours: base.estimatedHours }, policy);
  const allocation = quoteJunkAllocation({
    basePriceCents: base.allInCents,
    disposalCents,
    crew,
    bookingProtectionCents: base.bookingProtectionFeeCents,
    policy,
  });

  const priceLines = base.lines.filter((l) => l.label !== "Booking protection");
  const lines: JunkQuoteLine[] = [
    ...priceLines,
    ...allocation.lines,
    { label: "Booking protection", cents: base.bookingProtectionFeeCents },
  ];

  const plan: JunkQuotePlan = {
    model: JUNK_ALLOCATION_MODEL,
    policyVersion: PAYMENT_POLICY_VERSION,
    marketCode: policy.marketCode,
    basePriceCents: base.allInCents,
    secondHelperAdjustmentCents: allocation.secondHelperAdjustmentCents,
    floorAdjustmentCents: allocation.floorAdjustmentCents,
    allInCents: allocation.allInCents,
    disposalCents: allocation.disposalCents,
    subtotalCents: allocation.subtotalCents,
    platformFeeBps: policy.platformFeeBps,
    platformFeeCents: allocation.platformFeeCents,
    helperHourlyCents: policy.helperHourlyCents,
    helperMinimumMinutes: policy.helperMinimumMinutes,
    helperIncrementMinutes: policy.helperIncrementMinutes,
    helperCount: crew.helperCount,
    jobMinutes: crew.jobMinutes,
    helperMinutes: crew.helperMinutes,
    helperPayableMinutes: allocation.helperPayableMinutes,
    helperCompCents: allocation.helperCompCents,
    helperTotalCents: allocation.helperTotalCents,
    haulerServiceCents: allocation.haulerServiceCents,
    haulerTransferCents: allocation.haulerTransferCents,
    haulerFloorCents: policy.haulerFloorCents,
    truckAllowanceCents: policy.truckAllowanceCents,
    bookingProtectionCents: base.bookingProtectionFeeCents,
    totalCents: allocation.totalCents,
    repriced: allocation.repriced,
    policyApprovedByCarl: policy.carlApprovedAt !== null,
  };

  const publicQuote: PublicJunkQuote = {
    pricingMode: base.pricingMode,
    servicePriceCents: base.servicePriceCents,
    surchargesCents: base.surchargesCents,
    allInCents: allocation.allInCents,
    helpersRequired: base.helpersRequired,
    crewSize: base.crewSize,
    bookingProtectionFeeCents: base.bookingProtectionFeeCents,
    totalCents: allocation.totalCents,
    estimatedHours: base.estimatedHours,
    lines,
    serviceCents: allocation.allInCents - allocation.disposalCents,
    disposalEstimateCents: allocation.disposalCents,
    helperHourlyCents: policy.helperHourlyCents,
    helperMinimumHours: policy.helperMinimumMinutes / 60,
  };

  return { base, allocation, policy, plan, publicQuote };
}

/** Prices a junk job for a market: Carl's tables plus the market's payment policy. */
export async function quoteJunkForMarket(marketCode: string, details: JunkJobDetailsInput): Promise<JunkFullQuote> {
  const [pricing, policy] = await Promise.all([resolveJunkMarketPricing(marketCode), resolvePaymentPolicy(marketCode)]);
  return buildJunkFullQuote({ ...pricing, ...details }, policy);
}
