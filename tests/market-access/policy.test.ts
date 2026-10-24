import { describe, it, expect } from "vitest";
import { assignmentGrants, hasMarketAccess, type Assignment, type MarketTarget } from "@/lib/market-access-policy";

const target: MarketTarget = { marketId: "M1", state: "IN", territoryId: "T1" };
const otherMarket: MarketTarget = { marketId: "M2", state: "OH", territoryId: "T2" };

describe("assignmentGrants — PLATFORM", () => {
  it("grants access to any market", () => {
    const a: Assignment = { scope: "PLATFORM" };
    expect(assignmentGrants(a, target)).toBe(true);
    expect(assignmentGrants(a, otherMarket)).toBe(true);
  });
});

describe("assignmentGrants — STATE", () => {
  it("grants access to markets in the same state", () => {
    expect(assignmentGrants({ scope: "STATE", state: "IN" }, target)).toBe(true);
  });
  it("denies markets in other states", () => {
    expect(assignmentGrants({ scope: "STATE", state: "IN" }, otherMarket)).toBe(false);
  });
  it("is case-insensitive on the state code", () => {
    expect(assignmentGrants({ scope: "STATE", state: "in" }, target)).toBe(true);
  });
  it("denies when the assignment has no state", () => {
    expect(assignmentGrants({ scope: "STATE", state: null }, target)).toBe(false);
  });
});

describe("assignmentGrants — MARKET", () => {
  it("grants the exact market only", () => {
    expect(assignmentGrants({ scope: "MARKET", marketId: "M1" }, target)).toBe(true);
    expect(assignmentGrants({ scope: "MARKET", marketId: "M1" }, otherMarket)).toBe(false);
  });
  it("denies when marketId is missing", () => {
    expect(assignmentGrants({ scope: "MARKET", marketId: null }, target)).toBe(false);
  });
});

describe("assignmentGrants — TERRITORY", () => {
  it("grants the exact territory only", () => {
    expect(assignmentGrants({ scope: "TERRITORY", territoryId: "T1" }, target)).toBe(true);
  });
  it("does NOT grant the parent market or sibling territories", () => {
    expect(assignmentGrants({ scope: "TERRITORY", territoryId: "T1" }, { marketId: "M1", state: "IN", territoryId: "T9" })).toBe(false);
    // No territory on the request → a territory-scoped assignment can't match.
    expect(assignmentGrants({ scope: "TERRITORY", territoryId: "T1" }, { marketId: "M1", state: "IN", territoryId: null })).toBe(false);
  });
});

describe("assignmentGrants — inactive", () => {
  it("an inactive assignment grants nothing", () => {
    expect(assignmentGrants({ scope: "PLATFORM", active: false }, target)).toBe(false);
  });
});

describe("hasMarketAccess — combinations", () => {
  it("grants if ANY assignment grants", () => {
    const assignments: Assignment[] = [
      { scope: "MARKET", marketId: "M9" }, // no
      { scope: "STATE", state: "IN" },     // yes
    ];
    expect(hasMarketAccess(assignments, target)).toBe(true);
  });
  it("denies if NONE grant", () => {
    const assignments: Assignment[] = [
      { scope: "MARKET", marketId: "M9" },
      { scope: "STATE", state: "OH" },
      { scope: "TERRITORY", territoryId: "T9" },
    ];
    expect(hasMarketAccess(assignments, target)).toBe(false);
  });
  it("empty assignments deny", () => {
    expect(hasMarketAccess([], target)).toBe(false);
  });
  it("a platform admin with an unrelated market assignment still gets access via PLATFORM", () => {
    expect(hasMarketAccess([{ scope: "MARKET", marketId: "M9" }, { scope: "PLATFORM" }], target)).toBe(true);
  });
  it("inactive assignments are ignored in the mix", () => {
    expect(hasMarketAccess([{ scope: "PLATFORM", active: false }, { scope: "STATE", state: "OH" }], target)).toBe(false);
  });
});
