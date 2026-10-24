import { describe, it, expect } from "vitest";
import { hasMarketAccess, type Assignment } from "@/lib/market-access-policy";

/**
 * Settlement partial-authorization regression matrix (handoff Option 1). The
 * DB fetch of assignments is the only non-pure part of partitionByMarketAccess;
 * the DECISION is hasMarketAccess, exercised here directly across the doc's
 * required scenarios plus mixed-market batches.
 */
type Load = { record: string; marketId: string | null; marketState: string | null; marketLabel: string | null; territoryId?: string | null };

function partition(assignments: Assignment[], records: Load[]) {
  const authorized: string[] = [];
  const skip = new Map<string, number>();
  for (const r of records) {
    const target = r.marketId && r.marketState != null ? { marketId: r.marketId, state: r.marketState, territoryId: r.territoryId ?? null } : null;
    const allowed = target ? hasMarketAccess(assignments, target) : assignments.some(a => a.scope === "PLATFORM" && a.active !== false);
    if (allowed) authorized.push(r.record);
    else { const l = r.marketLabel ?? "Unknown"; skip.set(l, (skip.get(l) ?? 0) + 1); }
  }
  return { authorized, skipped: [...skip.entries()].map(([marketLabel, count]) => ({ marketLabel, count })) };
}

const loads: Load[] = [
  { record: "L1", marketId: "M-indy", marketState: "IN", marketLabel: "Indianapolis" },
  { record: "L2", marketId: "M-chi", marketState: "IL", marketLabel: "Chicago" },
  { record: "L3", marketId: "M-mke", marketState: "WI", marketLabel: "Milwaukee" },
  { record: "L4", marketId: "M-indy", marketState: "IN", marketLabel: "Indianapolis" },
];

describe("settlement partial authorization", () => {
  it("PLATFORM settles every market", () => {
    const r = partition([{ scope: "PLATFORM" }], loads);
    expect(r.authorized.length).toBe(4);
    expect(r.skipped).toEqual([]);
  });
  it("STATE admin settles only same-state, reports skipped", () => {
    const r = partition([{ scope: "STATE", state: "IN" }], loads);
    expect(r.authorized).toEqual(["L1", "L4"]);
    expect(r.skipped.map(s => s.marketLabel).sort()).toEqual(["Chicago", "Milwaukee"]);
  });
  it("MARKET admin settles only its market", () => {
    const r = partition([{ scope: "MARKET", marketId: "M-indy" }], loads);
    expect(r.authorized).toEqual(["L1", "L4"]);
    expect(r.skipped.length).toBe(2);
  });
  it("TERRITORY admin with no territory match skips all", () => {
    const r = partition([{ scope: "TERRITORY", territoryId: "T1" }], loads);
    expect(r.authorized.length).toBe(0);
    expect(r.skipped.length).toBe(3);
  });
  it("inactive assignment denies all", () => {
    expect(partition([{ scope: "PLATFORM", active: false }], loads).authorized.length).toBe(0);
  });
  it("combined scopes union their authority", () => {
    const r = partition([{ scope: "STATE", state: "IN" }, { scope: "MARKET", marketId: "M-chi" }], loads);
    expect(r.authorized.sort()).toEqual(["L1", "L2", "L4"]);
    expect(r.skipped).toEqual([{ marketLabel: "Milwaukee", count: 1 }]);
  });
  it("fails closed on a load with no resolvable market (non-platform)", () => {
    const r = partition([{ scope: "STATE", state: "IN" }], [{ record: "Lx", marketId: null, marketState: null, marketLabel: null }]);
    expect(r.authorized.length).toBe(0);
    expect(r.skipped.length).toBe(1);
  });
  it("PLATFORM can settle a load with no resolvable market", () => {
    const r = partition([{ scope: "PLATFORM" }], [{ record: "Lx", marketId: null, marketState: null, marketLabel: null }]);
    expect(r.authorized.length).toBe(1);
  });
});
