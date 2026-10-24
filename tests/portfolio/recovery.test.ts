import { describe, it, expect } from "vitest";
import { recoveryAction, selectRecoveryActions, PROCESSING_TIMEOUT_MS, MAX_PROCESSING_ATTEMPTS, type StaleCandidate } from "@/lib/portfolio/recovery";

const now = new Date("2026-08-01T12:00:00Z");
const minsAgo = (m: number) => new Date(now.getTime() - m * 60_000);
const base = (o: Partial<StaleCandidate>): StaleCandidate => ({ id: "m", processingStatus: "PROCESSING", processingStartedAt: minsAgo(1), processingAttempts: 1, ...o });

describe("recoveryAction", () => {
  it("ignores non-PROCESSING rows", () => {
    expect(recoveryAction(base({ processingStatus: "PROCESSED" }), now)).toBe("none");
    expect(recoveryAction(base({ processingStatus: "PENDING" }), now)).toBe("none");
  });
  it("leaves a recently-started job alone", () => {
    expect(recoveryAction(base({ processingStartedAt: minsAgo(1) }), now)).toBe("none");
  });
  it("retries a stale job with attempts remaining", () => {
    expect(recoveryAction(base({ processingStartedAt: minsAgo(30), processingAttempts: 1 }), now)).toBe("retry");
  });
  it("fails a stale job that has exhausted attempts", () => {
    expect(recoveryAction(base({ processingStartedAt: minsAgo(30), processingAttempts: MAX_PROCESSING_ATTEMPTS }), now)).toBe("fail");
  });
  it("treats PROCESSING with no start time as stuck", () => {
    expect(recoveryAction(base({ processingStartedAt: null, processingAttempts: 1 }), now)).toBe("retry");
    expect(recoveryAction(base({ processingStartedAt: null, processingAttempts: MAX_PROCESSING_ATTEMPTS }), now)).toBe("fail");
  });
  it("boundary: exactly at timeout is not yet stale", () => {
    const at = new Date(now.getTime() - PROCESSING_TIMEOUT_MS);
    expect(recoveryAction(base({ processingStartedAt: at }), now)).toBe("none");
    const justPast = new Date(now.getTime() - PROCESSING_TIMEOUT_MS - 60_001);
    expect(recoveryAction(base({ processingStartedAt: justPast }), now)).toBe("retry");
  });
});

describe("selectRecoveryActions", () => {
  it("returns only actionable rows", () => {
    const rows = [
      base({ id: "fresh", processingStartedAt: minsAgo(1) }),
      base({ id: "retry", processingStartedAt: minsAgo(30), processingAttempts: 1 }),
      base({ id: "fail", processingStartedAt: minsAgo(30), processingAttempts: MAX_PROCESSING_ATTEMPTS }),
      base({ id: "done", processingStatus: "PROCESSED" }),
    ];
    expect(selectRecoveryActions(rows, now)).toEqual([
      { id: "retry", action: "retry" },
      { id: "fail", action: "fail" },
    ]);
  });
});
