import { describe, it, expect } from "vitest";
import { parseSavedSearchParams } from "@/lib/discovery/saved-search";

describe("parseSavedSearchParams", () => {
  it("accepts a valid filter set", () => {
    const r = parseSavedSearchParams({ workerType: "MOVER", minRating: 4, sort: "rating" });
    expect(r.ok).toBe(true);
  });

  it("rejects a filter with an unsupported field value", () => {
    const r = parseSavedSearchParams({ workerType: "ASTRONAUT" });
    expect(r.ok).toBe(false);
  });

  it("rejects an availability window with only one bound", () => {
    const r = parseSavedSearchParams({ availableFrom: new Date().toISOString() });
    expect(r.ok).toBe(false);
  });

  it("rejects a reversed availability window", () => {
    const from = new Date("2026-08-10T00:00:00Z").toISOString();
    const to = new Date("2026-08-01T00:00:00Z").toISOString();
    const r = parseSavedSearchParams({ availableFrom: from, availableTo: to });
    expect(r.ok).toBe(false);
  });

  it("rejects minRating out of range", () => {
    expect(parseSavedSearchParams({ minRating: 9 }).ok).toBe(false);
  });

  it("accepts an empty filter (browse all)", () => {
    expect(parseSavedSearchParams({}).ok).toBe(true);
  });
});
