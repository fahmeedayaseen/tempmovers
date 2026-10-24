/**
 * getCarrierEligibility(carrierId, capability, marketId) — the DB-backed entry
 * point every load-offer / carrier-assignment endpoint must call. Gathers the
 * carrier's real state and delegates the decision to the pure
 * computeCarrierEligibility. Returns structured { eligible, blockers }.
 */
import { prisma } from "@/lib/db";
import { computeCarrierEligibility, type EligibilityResult } from "@/lib/carriers/eligibility";
import { isBrokerageCapabilityEnabled, type BrokerageCapability } from "@/lib/compliance/service-separation";
import { isFmcsaCheckStale } from "@/lib/carriers/fmcsa";
import type { InsurancePolicyView, CarrierStatus } from "@/lib/carriers/lifecycle";

export type CarrierCapability =
  | "RECEIVE_LOAD_OFFER"      // launch-safe (dispatch) — not brokerage-gated
  | "BROKER_LOAD_ASSIGNMENT"; // brokerage-gated

const REQUIRED_INSURANCE: InsurancePolicyView["type"][] = ["AUTO_LIABILITY", "CARGO"];
const REQUIRED_DOCS = ["W9"];

export async function getCarrierEligibility(
  carrierId: string,
  capability: CarrierCapability,
  marketId?: string | null,
): Promise<EligibilityResult> {
  const carrier = await prisma.carrier.findUnique({
    where: { id: carrierId },
    include: {
      insurancePolicies: true,
      documents: true,
      agreements: true,
      fmcsaChecks: { orderBy: { checkedAt: "desc" }, take: 1 },
      factoringProfile: true,
      paymentAssignments: { where: { status: "PENDING_REVIEW" }, take: 1 },
    },
  });
  if (!carrier) return { eligible: false, blockers: [{ code: "CARRIER_NOT_FOUND", message: "Carrier not found." }] };

  const now = new Date();
  const capabilityRequiresBrokerage = capability === "BROKER_LOAD_ASSIGNMENT";

  // Market eligibility: the carrier's market must have the relevant service on.
  let marketEligible = true;
  let marketBrokerageEnabled = false;
  const effectiveMarketId = marketId ?? carrier.marketId ?? undefined;
  if (effectiveMarketId) {
    const market = await prisma.launchMarket.findUnique({ where: { id: effectiveMarketId } });
    if (!market) {
      marketEligible = false;
    } else {
      marketBrokerageEnabled = market.freightBrokerageEnabled;
      // For a dispatch/load offer the market must at least allow freight; for a
      // brokered assignment the brokerage flag is checked separately below.
      marketEligible = capabilityRequiresBrokerage ? true : (market.freightEnabled || market.dispatchSupportEnabled);
    }
  }

  const globalCapabilityEnabled = capabilityRequiresBrokerage
    ? await isBrokerageCapabilityEnabled("carrierLoadAcceptance" as BrokerageCapability).catch(() => false)
    : true;

  const latestFmcsa = carrier.fmcsaChecks[0];
  const approvedDocuments = carrier.documents.filter((d) => d.verified).map((d) => d.type);
  const hasActiveRequiredAgreement = carrier.agreements.some((a) => a.active);

  return computeCarrierEligibility({
    carrierStatus: carrier.status as CarrierStatus,
    requiredInsurance: REQUIRED_INSURANCE,
    policies: carrier.insurancePolicies.map((p) => ({ type: p.type as InsurancePolicyView["type"], expiresAt: p.expiresAt ? p.expiresAt.toISOString() : null })),
    requiredApprovedDocuments: REQUIRED_DOCS,
    approvedDocuments,
    fmcsaAuthorized: latestFmcsa ? latestFmcsa.authorized : null,
    fmcsaCheckedAt: latestFmcsa ? latestFmcsa.checkedAt.toISOString() : null,
    fmcsaStale: latestFmcsa ? isFmcsaCheckStale(latestFmcsa.checkedAt.toISOString(), now) : true,
    fmcsaRequired: true,
    hasActiveRequiredAgreement,
    agreementRequired: capabilityRequiresBrokerage, // dispatch offers don't require a broker-carrier agreement
    paymentRoutingUnderReview: carrier.paymentAssignments.length > 0,
    marketEligible,
    globalCapabilityEnabled,
    capabilityRequiresBrokerage,
    marketBrokerageEnabled,
    administrativeHold: carrier.status === "SUSPENDED" || carrier.status === "TEMPORARILY_INACTIVE",
    now,
  });
}
