import { describe, it, expect } from "vitest";
import { hasMarketAccess, type Assignment } from "@/lib/market-access-policy";

/**
 * Settlement preview summary (handoff Option 3, steps 5–6). Verifies the full
 * summary the preview + confirmation flow surfaces: eligible count/total/IDs,
 * skipped count/IDs/markets, and the exclusion reason. Mirrors
 * buildSettlementPreview's pure computation (the DB fetch is the only non-pure
 * part).
 */
type Load = { id: string; gross: number; marketId: string | null; marketState: string | null; marketLabel: string | null };

function preview(assignments: Assignment[], loads: Load[]) {
  const authorized: Load[] = [];
  const skip = new Map<string, number>();
  for (const r of loads) {
    const target = r.marketId && r.marketState != null ? { marketId: r.marketId, state: r.marketState, territoryId: null } : null;
    const allowed = target ? hasMarketAccess(assignments, target) : assignments.some(a => a.scope === "PLATFORM" && a.active !== false);
    if (allowed) authorized.push(r);
    else { const l = r.marketLabel ?? "Unknown"; skip.set(l, (skip.get(l) ?? 0) + 1); }
  }
  const authIds = new Set(authorized.map(l => l.id));
  const skippedLoadIds = loads.filter(l => !authIds.has(l.id)).map(l => l.id);
  return {
    eligibleCount: authorized.length,
    eligibleTotalCents: authorized.reduce((s, l) => s + l.gross, 0),
    eligibleLoadIds: authorized.map(l => l.id),
    skippedCount: skippedLoadIds.length,
    skippedLoadIds,
    skippedMarkets: [...skip.entries()].map(([marketLabel, count]) => ({ marketLabel, count })),
    exclusionReason: skippedLoadIds.length > 0 ? "Outside administrator authorization scope." : null,
  };
}

const loads: Load[] = [
  { id: "L1", gross: 190000, marketId: "M-indy", marketState: "IN", marketLabel: "Indianapolis" },
  { id: "L2", gross: 200000, marketId: "M-chi", marketState: "IL", marketLabel: "Chicago" },
  { id: "L3", gross: 150000, marketId: "M-mke", marketState: "WI", marketLabel: "Milwaukee" },
];

describe("settlement preview summary", () => {
  it("STATE admin: partial eligible with full skipped detail", () => {
    const p = preview([{ scope: "STATE", state: "IN" }], loads);
    expect(p.eligibleCount).toBe(1);
    expect(p.eligibleTotalCents).toBe(190000);
    expect(p.eligibleLoadIds).toEqual(["L1"]);
    expect(p.skippedCount).toBe(2);
    expect(p.skippedLoadIds.sort()).toEqual(["L2", "L3"]);
    expect(p.skippedMarkets.map(s => s.marketLabel).sort()).toEqual(["Chicago", "Milwaukee"]);
    expect(p.exclusionReason).toBe("Outside administrator authorization scope.");
  });
  it("PLATFORM admin: everything eligible, nothing skipped, no reason", () => {
    const p = preview([{ scope: "PLATFORM" }], loads);
    expect(p.eligibleCount).toBe(3);
    expect(p.eligibleTotalCents).toBe(540000);
    expect(p.skippedLoadIds).toEqual([]);
    expect(p.exclusionReason).toBeNull();
  });
});
