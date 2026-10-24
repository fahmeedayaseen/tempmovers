import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the flag gate so we can drive flag states deterministically.
const flags: Record<string, boolean> & { __throw?: boolean } = {};
vi.mock("@/lib/feature-flags/gate", () => ({
  isFeatureEnabled: async (k: string) => {
    if (flags.__throw) throw new Error("gate error");
    return !!flags[k];
  },
}));

import {
  isBrokerageCapabilityEnabled,
  assertBrokerageAllowed,
  mayRepresentAsBroker,
  isDispatchEnabled,
  BrokerageNotAuthorizedError,
} from "@/lib/compliance/service-separation";

function setFlags(f: Record<string, boolean | undefined>) {
  for (const k of Object.keys(flags)) delete (flags as Record<string, unknown>)[k];
  Object.assign(flags, f);
}

beforeEach(() => setFlags({}));

describe("brokerage compliance boundary — fail closed", () => {
  it("master OFF disables every capability even if the capability flag is on", async () => {
    setFlags({ LOAD_POSTING_ENABLED: true, CARRIER_PAYMENTS_ENABLED: true });
    expect(await isBrokerageCapabilityEnabled("loadPosting")).toBe(false);
    expect(await isBrokerageCapabilityEnabled("carrierPayments")).toBe(false);
    expect(await mayRepresentAsBroker()).toBe(false);
  });

  it("master ON but capability OFF disables that capability", async () => {
    setFlags({ FREIGHT_BROKERAGE_ENABLED: true, LOAD_POSTING_ENABLED: false });
    expect(await isBrokerageCapabilityEnabled("loadPosting")).toBe(false);
    expect(await mayRepresentAsBroker()).toBe(true);
  });

  it("master ON + capability ON enables it", async () => {
    setFlags({ FREIGHT_BROKERAGE_ENABLED: true, LOAD_POSTING_ENABLED: true });
    expect(await isBrokerageCapabilityEnabled("loadPosting")).toBe(true);
  });

  it("assertBrokerageAllowed throws 403 when inactive, passes when active", async () => {
    setFlags({});
    await expect(assertBrokerageAllowed("rateConfirmationGeneration")).rejects.toBeInstanceOf(BrokerageNotAuthorizedError);
    setFlags({ FREIGHT_BROKERAGE_ENABLED: true, RATE_CONFIRMATION_GENERATION_ENABLED: true });
    await expect(assertBrokerageAllowed("rateConfirmationGeneration")).resolves.toBeUndefined();
  });

  it("fails closed on gate error", async () => {
    setFlags({ __throw: true });
    expect(await isBrokerageCapabilityEnabled("loadPosting")).toBe(false);
  });

  it("dispatch support operates independently of the brokerage master flag", async () => {
    setFlags({ DISPATCH_SERVICES_ENABLED: true });
    expect(await isDispatchEnabled()).toBe(true);
    expect(await mayRepresentAsBroker()).toBe(false);
  });
});
