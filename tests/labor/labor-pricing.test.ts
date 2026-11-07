import { describe, expect, it } from "vitest";
import { DEFAULT_LABOR_ONLY_POLICY, laborCustomerRatePerHourCents, quoteLaborOnly, settleLaborOnly } from "@/lib/labor/labor-pricing";

// Labor-only (Model B, Option A). Every worker billable (no included helper);
// the $42.86/worker-hour customer rate embeds the 30% fee; workers paid $30/hr.

describe("labor-only pricing", () => {
  it("customer rate embeds the 30% fee: $30 / 0.70 = $42.86/worker-hour", () => {
    expect(laborCustomerRatePerHourCents(DEFAULT_LABOR_ONLY_POLICY)).toBe(4286);
  });

  it("§6 example: 2 workers × 3h → $257.16 (no second fee at checkout)", () => {
    const q = quoteLaborOnly({ workers: 2, estimatedHours: 3 });
    expect(q.perWorkerChargeCents).toBe(12858);
    expect(q.allInCents).toBe(25716);
  });

  it("every worker is billed — there is no included helper", () => {
    expect(quoteLaborOnly({ workers: 1, estimatedHours: 3 }).allInCents).toBe(12858);
    expect(quoteLaborOnly({ workers: 2, estimatedHours: 3 }).allInCents).toBe(25716);
  });

  it("rejects out-of-range / non-integer worker counts", () => {
    expect(() => quoteLaborOnly({ workers: 0, estimatedHours: 3 })).toThrow();
    expect(() => quoteLaborOnly({ workers: 11, estimatedHours: 3 })).toThrow();
    expect(() => quoteLaborOnly({ workers: 1.5, estimatedHours: 3 })).toThrow();
  });

  it("settlement: workers paid $30/hr, platform keeps fee + $0.01 remainder, reconciles", () => {
    const s = settleLaborOnly({
      fundedAllInCents: 25716,
      workers: [{ payeeId: "w1", actualMinutes: 180, classificationVerified: true }, { payeeId: "w2", actualMinutes: 180, classificationVerified: true }],
      policy: DEFAULT_LABOR_ONLY_POLICY,
    });
    expect(s.requiresHold).toBe(false);
    expect(s.platformFeeCents).toBe(7715);
    expect(s.workerCompCents).toBe(18000);
    expect(s.platformNetCents).toBe(7716); // fee + $0.01 rounding remainder
    expect(s.remainderCents).toBe(1);
    expect(s.rows.reduce((a, r) => a + r.amountCents, 0)).toBe(25716);
    expect(s.rows.filter((r) => r.recipient === "WORKER").every((r) => r.amountCents === 9000)).toBe(true);
  });

  it("classification incomplete → payout HELD, no rows", () => {
    const s = settleLaborOnly({
      fundedAllInCents: 25716,
      workers: [{ payeeId: "w1", actualMinutes: 180, classificationVerified: true }, { payeeId: "w2", actualMinutes: 180 /* unverified */ }],
      policy: DEFAULT_LABOR_ONLY_POLICY,
    });
    expect(s.requiresHold).toBe(true);
    expect(s.rows.length).toBe(0);
  });
});
