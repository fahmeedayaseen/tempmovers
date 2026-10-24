import { describe, it, expect } from "vitest";
import { canTransition, assertTransition, evaluateLoadEligibility, autoExpireIfInsuranceLapsed } from "@/lib/carriers/lifecycle";
import { classifyExpiry, findExpiringItems } from "@/lib/carriers/expiration";
import { isFmcsaCheckStale } from "@/lib/carriers/fmcsa";

const now = new Date("2026-08-01T00:00:00Z");
const future = "2027-01-01T00:00:00Z";
const past = "2026-01-01T00:00:00Z";

describe("carrier status transitions (rules #1, #2)", () => {
  it("a fresh account cannot jump to ACTIVE or APPROVED", () => {
    expect(canTransition("APPLICATION_STARTED", "ACTIVE")).toBe(false);
    expect(canTransition("APPLICATION_STARTED", "APPROVED")).toBe(false);
  });
  it("ACTIVE is reachable only after APPROVED", () => {
    expect(canTransition("UNDER_REVIEW", "ACTIVE")).toBe(false);
    expect(canTransition("APPROVED", "ACTIVE")).toBe(true);
  });
  it("the full approval path is legal", () => {
    expect(canTransition("APPLICATION_STARTED", "DOCUMENTS_PENDING")).toBe(true);
    expect(canTransition("DOCUMENTS_PENDING", "UNDER_REVIEW")).toBe(true);
    expect(canTransition("UNDER_REVIEW", "APPROVED")).toBe(true);
    expect(canTransition("APPROVED", "ACTIVE")).toBe(true);
  });
  it("assertTransition throws on an illegal jump", () => {
    expect(() => assertTransition("APPLICATION_STARTED", "ACTIVE")).toThrow();
  });
});

describe("carrier load eligibility (rules #1, #2, #3)", () => {
  it("APPROVED (not ACTIVE) cannot receive loads", () => {
    const e = evaluateLoadEligibility({ status: "APPROVED", policies: [{ type: "AUTO_LIABILITY", expiresAt: future }], now, requiredInsurance: ["AUTO_LIABILITY"] });
    expect(e.eligible).toBe(false);
  });
  it("ACTIVE with valid required insurance is eligible", () => {
    const e = evaluateLoadEligibility({ status: "ACTIVE", policies: [{ type: "AUTO_LIABILITY", expiresAt: future }, { type: "CARGO", expiresAt: future }], now, requiredInsurance: ["AUTO_LIABILITY", "CARGO"] });
    expect(e.eligible).toBe(true);
  });
  it("expired insurance removes eligibility", () => {
    const e = evaluateLoadEligibility({ status: "ACTIVE", policies: [{ type: "AUTO_LIABILITY", expiresAt: past }], now, requiredInsurance: ["AUTO_LIABILITY"] });
    expect(e.eligible).toBe(false);
  });
  it("auto-expires an ACTIVE carrier whose required insurance lapsed", () => {
    expect(autoExpireIfInsuranceLapsed("ACTIVE", [{ type: "AUTO_LIABILITY", expiresAt: past }], ["AUTO_LIABILITY"], now)).toBe("EXPIRED_DOCUMENTS");
    expect(autoExpireIfInsuranceLapsed("ACTIVE", [{ type: "AUTO_LIABILITY", expiresAt: future }], ["AUTO_LIABILITY"], now)).toBeNull();
    expect(autoExpireIfInsuranceLapsed("APPROVED", [{ type: "AUTO_LIABILITY", expiresAt: past }], ["AUTO_LIABILITY"], now)).toBeNull();
  });
});

describe("document/insurance expiration alerts", () => {
  it("classifies expired / expiring-soon / ok / no-date", () => {
    expect(classifyExpiry(past, now).state).toBe("EXPIRED");
    expect(classifyExpiry("2026-08-20T00:00:00Z", now).state).toBe("EXPIRING_SOON");
    expect(classifyExpiry(future, now).state).toBe("OK");
    expect(classifyExpiry(null, now).state).toBe("NO_DATE");
  });
  it("returns only actionable items", () => {
    const items = findExpiringItems({
      documents: [{ type: "W9", expiresAt: future }, { type: "CERTIFICATE_OF_INSURANCE", expiresAt: past }],
      policies: [{ type: "AUTO_LIABILITY", expiresAt: "2026-08-15T00:00:00Z" }, { type: "CARGO", expiresAt: future }],
    }, now);
    expect(items).toHaveLength(2);
    expect(items.some((i) => i.label === "CERTIFICATE_OF_INSURANCE" && i.state === "EXPIRED")).toBe(true);
    expect(items.some((i) => i.label === "AUTO_LIABILITY" && i.state === "EXPIRING_SOON")).toBe(true);
  });
});

describe("FMCSA check staleness (rule #4 — not permanently valid)", () => {
  it("a check older than the max age is stale", () => {
    expect(isFmcsaCheckStale("2026-06-01T00:00:00Z", now)).toBe(true);
    expect(isFmcsaCheckStale("2026-07-25T00:00:00Z", now)).toBe(false);
  });
});
