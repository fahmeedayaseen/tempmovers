import { describe, it, expect } from "vitest";
import { computeBatchFingerprint, type FingerprintLoad } from "@/lib/settlements/preview-token";

/**
 * Settlement preview-token fingerprint (TOCTOU protection). The fingerprint
 * must be deterministic and order-independent, and must change whenever the
 * batch materially changes between preview and confirmation.
 */
const base = {
  workerId: "W1",
  periodStart: "2026-07-01T00:00:00.000Z",
  periodEnd: "2026-07-31T00:00:00.000Z",
  eligible: [
    { id: "L1", grossCarrierCents: 190000, paymentStatus: "CAPTURED", settlementId: null },
    { id: "L2", grossCarrierCents: 200000, paymentStatus: "CAPTURED", settlementId: null },
  ] as FingerprintLoad[],
  skippedLoadIds: ["L3"],
};

describe("computeBatchFingerprint", () => {
  const h0 = computeBatchFingerprint(base);

  it("is deterministic", () => {
    expect(computeBatchFingerprint(base)).toBe(h0);
  });
  it("is order-independent across eligible loads", () => {
    expect(computeBatchFingerprint({ ...base, eligible: [base.eligible[1], base.eligible[0]] })).toBe(h0);
  });
  it("changes when a load amount changes", () => {
    expect(computeBatchFingerprint({ ...base, eligible: [{ ...base.eligible[0], grossCarrierCents: 999 }, base.eligible[1]] })).not.toBe(h0);
  });
  it("changes when a load is removed", () => {
    expect(computeBatchFingerprint({ ...base, eligible: [base.eligible[0]] })).not.toBe(h0);
  });
  it("changes when a load is added", () => {
    expect(computeBatchFingerprint({ ...base, eligible: [...base.eligible, { id: "L9", grossCarrierCents: 100, paymentStatus: "CAPTURED", settlementId: null }] })).not.toBe(h0);
  });
  it("changes when a payment status changes", () => {
    expect(computeBatchFingerprint({ ...base, eligible: [{ ...base.eligible[0], paymentStatus: "REFUNDED" }, base.eligible[1]] })).not.toBe(h0);
  });
  it("changes when a load is settled elsewhere", () => {
    expect(computeBatchFingerprint({ ...base, eligible: [{ ...base.eligible[0], settlementId: "S9" }, base.eligible[1]] })).not.toBe(h0);
  });
  it("changes when the skipped set changes", () => {
    expect(computeBatchFingerprint({ ...base, skippedLoadIds: ["L3", "L4"] })).not.toBe(h0);
  });
  it("changes when the period changes", () => {
    expect(computeBatchFingerprint({ ...base, periodEnd: "2026-08-01T00:00:00.000Z" })).not.toBe(h0);
  });
});
