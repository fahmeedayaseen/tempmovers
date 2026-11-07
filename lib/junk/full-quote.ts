import { calculateJunkQuote, sizeRank, type JunkQuote, type JunkQuoteInput, type JunkQuoteLine } from "@/lib/junk/pricing";
import { estimateDisposalCents, planJunkCrew, quoteJunkAllocation, type JunkAllocationQuote } from "@/lib/junk/allocation";
import { resolveJunkMarketPricing } from "@/lib/junk/market-pricing";
import { PAYMENT_POLICY_VERSION, resolvePaymentPolicy, type ResolvedPaymentPolicy } from "@/lib/payments/policy";
import type { JunkJobDetailsInput } from "@/lib/junk/request-schema";

// ---------------------------------------------------------------------------
// Junk quote under the full allocation model — VASRUE Digital Media, 29 Oct 2026.
//
// Model B (2 Nov 2026): Carl's tier/item prices set the base price; the engine
// takes the 30% platform fee on the FULL price, plans hourly helpers, grosses
// up the price for additional helpers so the hauler is never docked, and
// reprices anything that would leave the hauler under the earnings floor.
// Disposal is an INTERNAL estimate only — never a customer line, never
// reimbursed, never refunded. The customer sees ONE flat all-inclusive price;
// the crew split stays internal and is snapshotted onto the booking as the plan.
// ---------------------------------------------------------------------------

export const JUNK_ALLOCATION_MODEL = "JUNK_FULL_ALLOCATION_V1" as const;

export type JunkQuotePlan = {
  model: typeof JUNK_ALLOCATION_MODEL;
  policyVersion: string;
  marketCode: string;
  serviceLevel: JunkQuote["serviceLevel"];
  basePriceCents: number;
  helperGrossUpCents: number;
  floorAdjustmentCents: number;
  allInCents: number;
  /** Internal disposal ESTIMATE only (Model B): a pricing input, never billed, reimbursed or refunded. Admin/margin-reporting field. */
  disposalCents: number;
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
  serviceLevel: JunkQuote["serviceLevel"];
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
  /** The one flat all-inclusive service price (Model B). No separate disposal line — internal disposal is never shown to the customer. */
  serviceCents: number;
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
  // Crew-pricing handoff (2 Nov): the single checkout price is base + extra
  // helper-hour charges only. NOTHING is added on top — no mandatory booking
  // protection, no disposal fee. So junk carries no protection add-on.
  const bookingProtectionCents = 0;
  const allocation = quoteJunkAllocation({
    basePriceCents: base.allInCents,
    disposalEstimateCents: disposalCents,
    crew,
    bookingProtectionCents,
    policy,
  });

  // The customer sees ONE all-inclusive price (= base + extra helper-hour
  // charges); the internal crew/helper/disposal split is never itemized to the
  // customer (role privacy §6). The full breakdown lives in `plan` for admin.
  const lines: JunkQuoteLine[] = [{ label: "All-inclusive junk removal", cents: allocation.totalCents }];

  const plan: JunkQuotePlan = {
    model: JUNK_ALLOCATION_MODEL,
    policyVersion: PAYMENT_POLICY_VERSION,
    marketCode: policy.marketCode,
    serviceLevel: base.serviceLevel,
    basePriceCents: base.allInCents,
    helperGrossUpCents: allocation.helperGrossUpCents,
    floorAdjustmentCents: allocation.floorAdjustmentCents,
    allInCents: allocation.allInCents,
    disposalCents: allocation.disposalEstimateCents,
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
    bookingProtectionCents,
    totalCents: allocation.totalCents,
    repriced: allocation.repriced,
    policyApprovedByCarl: policy.carlApprovedAt !== null,
  };

  const publicQuote: PublicJunkQuote = {
    pricingMode: base.pricingMode,
    serviceLevel: base.serviceLevel,
    servicePriceCents: base.servicePriceCents,
    surchargesCents: base.surchargesCents,
    allInCents: allocation.allInCents,
    helpersRequired: base.helpersRequired,
    crewSize: base.crewSize,
    bookingProtectionFeeCents: bookingProtectionCents,
    totalCents: allocation.totalCents,
    estimatedHours: base.estimatedHours,
    lines,
    serviceCents: allocation.totalCents, // the one all-inclusive price (base + extra helpers; nothing on top)
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
