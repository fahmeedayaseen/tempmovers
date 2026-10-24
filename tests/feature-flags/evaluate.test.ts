import { describe, it, expect } from "vitest";
import { evaluateFlag, FUTURE_FEATURE_KEYS, type FeatureFlagConfig } from "@/lib/feature-flags/evaluate";

const base = (o: Partial<FeatureFlagConfig> = {}): FeatureFlagConfig => ({
  key: "AI_DISPATCH", enabled: true, status: "ENABLED",
  enabledEnvironments: [], enabledMarkets: [], enabledRoles: [], enabledServiceTypes: [], enabledPilotGroups: [], ...o,
});

describe("evaluateFlag — off by default & kill switches", () => {
  it("master switch off => OFF", () => {
    expect(evaluateFlag(base({ enabled: false }), {})).toBe(false);
  });
  it("status DISABLED => OFF even if enabled and targeting matches", () => {
    expect(evaluateFlag(base({ status: "DISABLED" }), { marketId: "M1" })).toBe(false);
  });
  it("naked ENABLED (no targeting) => ON everywhere", () => {
    expect(evaluateFlag(base(), { marketId: "anything", role: "ADMIN" })).toBe(true);
  });
});

describe("evaluateFlag — targeting axes", () => {
  it("market restriction: member passes, non-member fails", () => {
    const f = base({ enabledMarkets: ["M1", "M2"] });
    expect(evaluateFlag(f, { marketId: "M1" })).toBe(true);
    expect(evaluateFlag(f, { marketId: "M9" })).toBe(false);
    expect(evaluateFlag(f, {})).toBe(false); // restricted but no market on the request
  });
  it("role restriction", () => {
    const f = base({ enabledRoles: ["ADMIN"] });
    expect(evaluateFlag(f, { role: "ADMIN" })).toBe(true);
    expect(evaluateFlag(f, { role: "CUSTOMER" })).toBe(false);
    expect(evaluateFlag(f, {})).toBe(false);
  });
  it("environment restriction", () => {
    const f = base({ enabledEnvironments: ["staging"] });
    expect(evaluateFlag(f, { environment: "staging" })).toBe(true);
    expect(evaluateFlag(f, { environment: "production" })).toBe(false);
  });
  it("service-type restriction", () => {
    const f = base({ enabledServiceTypes: ["SEMI"] });
    expect(evaluateFlag(f, { serviceType: "SEMI" })).toBe(true);
    expect(evaluateFlag(f, { serviceType: "MOVING" })).toBe(false);
  });
  it("multiple axes must ALL match", () => {
    const f = base({ enabledMarkets: ["M1"], enabledRoles: ["ADMIN"] });
    expect(evaluateFlag(f, { marketId: "M1", role: "ADMIN" })).toBe(true);
    expect(evaluateFlag(f, { marketId: "M1", role: "CUSTOMER" })).toBe(false);
    expect(evaluateFlag(f, { marketId: "M9", role: "ADMIN" })).toBe(false);
  });
});

describe("evaluateFlag — PILOT", () => {
  it("PILOT requires a pilot-group match", () => {
    const f = base({ status: "PILOT", enabledPilotGroups: ["beta"] });
    expect(evaluateFlag(f, { pilotGroups: ["beta"] })).toBe(true);
    expect(evaluateFlag(f, { pilotGroups: ["other"] })).toBe(false);
    expect(evaluateFlag(f, {})).toBe(false);
  });
  it("PILOT with no configured groups => OFF", () => {
    expect(evaluateFlag(base({ status: "PILOT", enabledPilotGroups: [] }), { pilotGroups: ["beta"] })).toBe(false);
  });
  it("PILOT still honors other targeting", () => {
    const f = base({ status: "PILOT", enabledPilotGroups: ["beta"], enabledMarkets: ["M1"] });
    expect(evaluateFlag(f, { pilotGroups: ["beta"], marketId: "M1" })).toBe(true);
    expect(evaluateFlag(f, { pilotGroups: ["beta"], marketId: "M9" })).toBe(false);
  });
});

describe("future feature registry", () => {
  it("includes the documented keys and all default off", () => {
    expect(FUTURE_FEATURE_KEYS).toContain("AI_DISPATCH");
    expect(FUTURE_FEATURE_KEYS).toContain("INSURANCE_VERIFICATION");
    // A brand-new flag with defaults (disabled) is OFF.
    expect(evaluateFlag(base({ enabled: false, status: "DISABLED" }), {})).toBe(false);
  });
});
