import { describe, it, expect } from "vitest";
import { calculateDetention } from "@/lib/pricing";

describe("calculateDetention", () => {
  it("charges nothing when wait time is within the included minutes", () => {
    const result = calculateDetention({ actualWaitTimeMinutes: 45, includedMinutes: 60, hourlyRateCents: 4000 });
    expect(result.excessMinutes).toBe(0);
    expect(result.billableQuarterHours).toBe(0);
    expect(result.detentionCents).toBe(0);
  });

  it("charges nothing when wait time exactly matches the included minutes", () => {
    const result = calculateDetention({ actualWaitTimeMinutes: 60, includedMinutes: 60, hourlyRateCents: 4000 });
    expect(result.detentionCents).toBe(0);
  });

  it("rounds a partial excess quarter-hour up to the next billable increment", () => {
    // 75 minutes actual, 60 included -> 15 excess minutes -> exactly 1 quarter-hour
    const result = calculateDetention({ actualWaitTimeMinutes: 75, includedMinutes: 60, hourlyRateCents: 4000 });
    expect(result.excessMinutes).toBe(15);
    expect(result.billableQuarterHours).toBe(1);
    expect(result.detentionCents).toBe(1000); // $40/hr / 4 = $10 per quarter-hour
  });

  it("rounds UP even a single minute of overage into a full quarter-hour", () => {
    // 61 minutes actual, 60 included -> 1 excess minute -> still bills a full quarter-hour
    const result = calculateDetention({ actualWaitTimeMinutes: 61, includedMinutes: 60, hourlyRateCents: 4000 });
    expect(result.excessMinutes).toBe(1);
    expect(result.billableQuarterHours).toBe(1);
    expect(result.detentionCents).toBe(1000);
  });

  it("computes multiple full hours of detention correctly", () => {
    // 180 minutes actual, 60 included -> 120 excess minutes -> 8 quarter-hours -> 2 full hours
    const result = calculateDetention({ actualWaitTimeMinutes: 180, includedMinutes: 60, hourlyRateCents: 4000 });
    expect(result.excessMinutes).toBe(120);
    expect(result.billableQuarterHours).toBe(8);
    expect(result.detentionCents).toBe(8000); // 2 hours * $40/hr
  });

  it("never returns a negative excess when actual wait time is somehow less than included", () => {
    const result = calculateDetention({ actualWaitTimeMinutes: 10, includedMinutes: 60, hourlyRateCents: 4000 });
    expect(result.excessMinutes).toBe(0);
    expect(result.detentionCents).toBe(0);
  });

  it("returns zero detention when the configured hourly rate is zero", () => {
    const result = calculateDetention({ actualWaitTimeMinutes: 180, includedMinutes: 60, hourlyRateCents: 0 });
    expect(result.detentionCents).toBe(0);
  });
});
