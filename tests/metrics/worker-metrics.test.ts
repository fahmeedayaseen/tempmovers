import { describe, it, expect } from "vitest";
import { computeCompletionRate, computeMedianResponseMs, type AssignmentMetricRow } from "@/lib/metrics/worker-metrics";

const row = (status: AssignmentMetricRow["status"], createdMinsAgo = 0, respondedMinsAfter: number | null = null): AssignmentMetricRow => {
  const createdAt = new Date(Date.now() - createdMinsAgo * 60_000);
  return { status, createdAt, respondedAt: respondedMinsAfter == null ? null : new Date(createdAt.getTime() + respondedMinsAfter * 60_000) };
};

describe("computeCompletionRate", () => {
  it("counts APPROVED and CHECKED_OUT as completed", () => {
    expect(computeCompletionRate([row("APPROVED"), row("CHECKED_OUT")])).toBe(1);
  });
  it("counts NO_SHOW and CANCELED against the rate", () => {
    // 2 completed, 2 failed => 0.5
    expect(computeCompletionRate([row("APPROVED"), row("CHECKED_OUT"), row("NO_SHOW"), row("CANCELED")])).toBe(0.5);
  });
  it("excludes DECLINED and INVITED from the denominator", () => {
    // 1 completed, 0 failed, declines/invites ignored => 1.0, not dragged down
    expect(computeCompletionRate([row("APPROVED"), row("DECLINED"), row("INVITED"), row("APPLIED")])).toBe(1);
  });
  it("returns null (not 0) when there is no completed-or-failed data", () => {
    expect(computeCompletionRate([row("INVITED"), row("DECLINED")])).toBeNull();
    expect(computeCompletionRate([])).toBeNull();
  });
});

describe("computeMedianResponseMs", () => {
  it("returns the median gap for an odd count", () => {
    // gaps: 2, 4, 6 minutes => median 4 min
    const rows = [row("ACCEPTED", 10, 2), row("ACCEPTED", 10, 4), row("ACCEPTED", 10, 6)];
    expect(computeMedianResponseMs(rows)).toBe(4 * 60_000);
  });
  it("averages the two middle gaps for an even count", () => {
    // gaps: 2, 4, 6, 8 => median (4+6)/2 = 5 min
    const rows = [row("ACCEPTED", 10, 2), row("ACCEPTED", 10, 4), row("ACCEPTED", 10, 6), row("ACCEPTED", 10, 8)];
    expect(computeMedianResponseMs(rows)).toBe(5 * 60_000);
  });
  it("ignores unresponded assignments entirely", () => {
    const rows = [row("ACCEPTED", 10, 4), row("INVITED", 10, null)];
    expect(computeMedianResponseMs(rows)).toBe(4 * 60_000);
  });
  it("returns null when nothing has been responded to", () => {
    expect(computeMedianResponseMs([row("INVITED", 10, null)])).toBeNull();
    expect(computeMedianResponseMs([])).toBeNull();
  });
  it("discards negative (clock-skew) gaps", () => {
    const createdAt = new Date();
    const bad: AssignmentMetricRow = { status: "ACCEPTED", createdAt, respondedAt: new Date(createdAt.getTime() - 1000) };
    expect(computeMedianResponseMs([bad])).toBeNull();
  });
});
