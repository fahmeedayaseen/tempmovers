import { describe, it, expect } from "vitest";
import { combineBrokerageConditions } from "@/lib/compliance/market-brokerage";
import { evaluateMarketActivationReadiness } from "@/lib/markets/activation-readiness";
import { assembleReadinessDashboard } from "@/lib/markets/readiness-dashboard";

describe("market brokerage — market flag can never override global compliance", () => {
  it("global capability OFF => brokerage OFF even with market flag + permission on", () => {
    expect(combineBrokerageConditions(false, { marketFreightBrokerageEnabled: true, userHasPermission: true })).toBe(false);
  });
  it("requires all four: global + market + permission", () => {
    expect(combineBrokerageConditions(true, { marketFreightBrokerageEnabled: false, userHasPermission: true })).toBe(false);
    expect(combineBrokerageConditions(true, { marketFreightBrokerageEnabled: true, userHasPermission: false })).toBe(false);
    expect(combineBrokerageConditions(true, { marketFreightBrokerageEnabled: true, userHasPermission: true })).toBe(true);
  });
});

const fullReady = {
  hasZipOrBoundary: true, pricingConfigured: true, minimumBookingRulesConfigured: true,
  atLeastOneServiceEnabled: true, paymentProcessingAvailable: true, supportCoverageAssigned: true,
  approvedWorkerCount: 25, requiredWorkerThreshold: 25, approvedCarrierCount: 15, requiredCarrierThreshold: 15,
  freightServiceRequested: true, unresolvedLaunchBlockers: 0,
};

describe("market activation readiness", () => {
  it("fully configured market is ready with no blockers", () => {
    const r = evaluateMarketActivationReadiness(fullReady);
    expect(r.ready).toBe(true);
    expect(r.blockers).toHaveLength(0);
  });
  it("insufficient worker supply blocks activation", () => {
    const r = evaluateMarketActivationReadiness({ ...fullReady, approvedWorkerCount: 5 });
    expect(r.ready).toBe(false);
    expect(r.blockers.some((b) => b.includes("worker supply"))).toBe(true);
  });
  it("carrier threshold applies only when freight is requested", () => {
    expect(evaluateMarketActivationReadiness({ ...fullReady, freightServiceRequested: false, approvedCarrierCount: 0 }).ready).toBe(true);
    expect(evaluateMarketActivationReadiness({ ...fullReady, freightServiceRequested: true, approvedCarrierCount: 2 }).ready).toBe(false);
  });
  it("reports multiple blockers at once", () => {
    const r = evaluateMarketActivationReadiness({ ...fullReady, pricingConfigured: false, hasZipOrBoundary: false });
    expect(r.blockers).toHaveLength(2);
  });
});

describe("launch readiness dashboard — never fabricates", () => {
  it("preserves null for untracked metrics (not faked to 0)", () => {
    const d = assembleReadinessDashboard({
      approvedMovers: 30, activeMovers: 25, approvedDrivers: 12, activeDrivers: 10,
      approvedCarriers: null, carriersWithCurrentInsurance: null,
      registeredCustomers: null, recurringCustomers: null, signedPropertyPartners: 3, signedShippers: null,
      openBookingRequests: 5, waitlistCount: null,
      stripePaymentSuccessRate: null, failedPaymentCount: null, openProductionDefects: null,
      documentVerificationBacklog: null, migrationStatus: null, lastSuccessfulDeployment: null, lastEndToEndTestDate: null,
      jobsCompleted: 42, cancellationRate: null, averageRating: null,
      grossBookingValueCents: null, platformRevenueCents: null, workerPayoutCents: null,
    });
    expect(d.supply.approvedMovers).toBe(30);
    expect(d.supply.approvedCarriers).toBeNull();
    expect(d.platform.stripePaymentSuccessRate).toBeNull();
    expect(d.performance.jobsCompleted).toBe(42);
  });
});
