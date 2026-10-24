import { describe, it, expect } from "vitest";
import { deriveAvailabilityBadge, hasAvailabilityInWindow, type AvailabilityWindow } from "@/lib/discovery/availability-badge";

const now = new Date("2026-08-01T12:00:00Z");
const at = (offsetHours: number) => new Date(now.getTime() + offsetHours * 3_600_000);
const win = (startH: number, endH: number, isAvailable = true): AvailabilityWindow => ({ startsAt: at(startH), endsAt: at(endH), isAvailable });

describe("deriveAvailabilityBadge", () => {
  it("AVAILABLE_NOW when a window currently contains now", () => {
    expect(deriveAvailabilityBadge([win(-1, 1)], now)).toBe("AVAILABLE_NOW");
  });
  it("AVAILABLE_THIS_WEEK when an upcoming window starts within 7 days", () => {
    expect(deriveAvailabilityBadge([win(24, 30)], now)).toBe("AVAILABLE_THIS_WEEK");
  });
  it("AVAILABLE_LATER when the only window is more than 7 days out", () => {
    expect(deriveAvailabilityBadge([win(24 * 10, 24 * 10 + 2)], now)).toBe("AVAILABLE_LATER");
  });
  it("NO_UPCOMING when all windows are past or unavailable", () => {
    expect(deriveAvailabilityBadge([win(-5, -2), win(24, 30, false)], now)).toBe("NO_UPCOMING");
  });
  it("prefers AVAILABLE_NOW over a later window", () => {
    expect(deriveAvailabilityBadge([win(24, 30), win(-1, 1)], now)).toBe("AVAILABLE_NOW");
  });
});

describe("hasAvailabilityInWindow", () => {
  it("true when an available window overlaps the query range", () => {
    expect(hasAvailabilityInWindow([win(2, 6)], at(4), at(8))).toBe(true);
  });
  it("false when windows don't overlap", () => {
    expect(hasAvailabilityInWindow([win(2, 3)], at(5), at(8))).toBe(false);
  });
  it("false when the overlapping window is marked unavailable", () => {
    expect(hasAvailabilityInWindow([win(2, 6, false)], at(4), at(8))).toBe(false);
  });
});
