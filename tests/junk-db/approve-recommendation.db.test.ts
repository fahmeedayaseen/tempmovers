import { describe, it, expect, afterAll } from "vitest";
import type { UserRole } from "@prisma/client";
import { prisma } from "@/lib/db";
import { resolvePaymentPolicy } from "@/lib/payments/policy";
import { minimumAcceptablePriceCents } from "@/lib/junk/market-intelligence";
import { resolveApprovedJunkPrice } from "@/lib/junk/pricing";
import { approveMarketRecommendation, approveLegacyFullServicePricing } from "@/lib/junk/approve-recommendation";
import {
  RecommendationNotApprovedError, ApprovalForbiddenError, MarketPolicyNotApprovedError,
} from "@/lib/junk/pricing-approval";
import { ForbiddenError } from "@/lib/market-access";

// These require a migrated Postgres; skip cleanly in the no-DB CI step.
const HAS_DB = !!process.env.DATABASE_URL;

// Real-database integration tests for the price-approval transaction
// (correction round 4, item 5). Require a migrated Postgres (DATABASE_URL); run
// in the dedicated `junk-db` CI job and in staging — not in the no-DB CI step.

let seq = 0;
const uniq = (p: string) => `${p.toUpperCase()}-${Date.now()}-${seq++}`;

async function makeAdmin(role: UserRole, assign: { marketId?: string; platform?: boolean } = {}) {
  const user = await prisma.user.create({
    data: { email: `${uniq("admin")}@test.local`, role, status: "ACTIVE", passwordHash: "x", firstName: "T", lastName: "Admin" },
    select: { id: true },
  });
  if (assign.platform) await prisma.adminAssignment.create({ data: { userId: user.id, scope: "PLATFORM", active: true } });
  else if (assign.marketId) await prisma.adminAssignment.create({ data: { userId: user.id, scope: "MARKET", marketId: assign.marketId, active: true } });
  return user.id;
}

async function makeMarket(opts: { approvedPolicy?: boolean; junkPriceTable?: unknown } = {}) {
  const marketCode = uniq("mkt");
  const market = await prisma.launchMarket.create({
    data: { marketCode, name: `Test ${marketCode}`, state: "IN", zipCodes: ["46204"], junkRemovalEnabled: true },
    select: { id: true, marketCode: true },
  });
  await prisma.pricingRule.create({ data: { marketCode, junkPriceTable: (opts.junkPriceTable ?? {}) as never, active: true } });
  if (opts.approvedPolicy !== false) {
    await prisma.paymentPolicyConfig.create({ data: { marketCode, carlApprovedAt: new Date() } });
  }
  return market;
}

async function floorFor(marketCode: string, serviceLevel: "ECONOMY" | "FULL_SERVICE", tier: "HALF" | "SINGLE_ITEM") {
  const policy = await resolvePaymentPolicy(marketCode);
  return minimumAcceptablePriceCents({ tier, serviceLevel, policy });
}

async function makeRecommendation(marketCode: string, over: Partial<{ serviceLevel: "ECONOMY" | "FULL_SERVICE"; volumeTier: "HALF" | "SINGLE_ITEM"; recommendedPriceCents: number; floorPriceCents: number; status: "PENDING" | "APPROVED" }> = {}) {
  const serviceLevel = over.serviceLevel ?? "FULL_SERVICE";
  const volumeTier = over.volumeTier ?? "HALF";
  const floor = over.floorPriceCents ?? (await floorFor(marketCode, serviceLevel, volumeTier));
  return prisma.marketPriceRecommendation.create({
    data: {
      marketCode, serviceLevel, volumeTier,
      recommendedPriceCents: over.recommendedPriceCents ?? floor + 5000,
      floorPriceCents: floor,
      status: over.status ?? "PENDING",
    },
    select: { id: true },
  });
}

afterAll(async () => { await prisma.$disconnect(); });

describe.skipIf(!HAS_DB)("approveMarketRecommendation (DB transaction)", () => {
  it("authorised admin approves: writes the service-level slot, marks APPROVED, audits, and makes the exact rate billable", async () => {
    const market = await makeMarket();
    const admin = await makeAdmin("ADMIN", { marketId: market.id });
    const rec = await makeRecommendation(market.marketCode, { serviceLevel: "FULL_SERVICE", volumeTier: "HALF", recommendedPriceCents: 37200 });

    const res = await approveMarketRecommendation({ recommendationId: rec.id, actingUserId: admin, actingRole: "ADMIN" });
    expect(res.approvedPriceCents).toBe(37200);

    const rule = await prisma.pricingRule.findUnique({ where: { marketCode: market.marketCode } });
    const table = rule!.junkPriceTable as unknown as { serviceLevels?: { FULL_SERVICE?: { tiersCents?: { HALF?: number } } } };
    expect(table.serviceLevels?.FULL_SERVICE?.tiersCents?.HALF).toBe(37200);
    expect(resolveApprovedJunkPrice(rule!.junkPriceTable, "FULL_SERVICE", { pricingMode: "VOLUME", volumeTier: "HALF" }).approved).toBe(true);

    const updated = await prisma.marketPriceRecommendation.findUnique({ where: { id: rec.id } });
    expect(updated!.status).toBe("APPROVED");
    expect(updated!.approvedRateWrittenAt).not.toBeNull();
    const audit = await prisma.auditLog.findFirst({ where: { action: "JUNK_PRICE_APPROVED", entityId: rec.id } });
    expect(audit).not.toBeNull();
  });

  it("duplicate approval is rejected (recommendation no longer PENDING)", async () => {
    const market = await makeMarket();
    const admin = await makeAdmin("ADMIN", { marketId: market.id });
    const rec = await makeRecommendation(market.marketCode);
    await approveMarketRecommendation({ recommendationId: rec.id, actingUserId: admin, actingRole: "ADMIN" });
    await expect(approveMarketRecommendation({ recommendationId: rec.id, actingUserId: admin, actingRole: "ADMIN" }))
      .rejects.toThrow(RecommendationNotApprovedError);
  });

  it("concurrent approvals: exactly one wins", async () => {
    const market = await makeMarket();
    const admin = await makeAdmin("ADMIN", { marketId: market.id });
    const rec = await makeRecommendation(market.marketCode);
    const results = await Promise.allSettled([
      approveMarketRecommendation({ recommendationId: rec.id, actingUserId: admin, actingRole: "ADMIN" }),
      approveMarketRecommendation({ recommendationId: rec.id, actingUserId: admin, actingRole: "ADMIN" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });

  it("below-floor recommendation rolls back entirely (no price written, still PENDING, no audit)", async () => {
    const market = await makeMarket();
    const admin = await makeAdmin("ADMIN", { marketId: market.id });
    const floor = await floorFor(market.marketCode, "FULL_SERVICE", "HALF");
    const rec = await makeRecommendation(market.marketCode, { recommendedPriceCents: floor - 1, floorPriceCents: floor });
    await expect(approveMarketRecommendation({ recommendationId: rec.id, actingUserId: admin, actingRole: "ADMIN" }))
      .rejects.toThrow(RecommendationNotApprovedError);
    const rule = await prisma.pricingRule.findUnique({ where: { marketCode: market.marketCode } });
    expect((rule!.junkPriceTable as unknown as { serviceLevels?: unknown }).serviceLevels).toBeUndefined();
    const still = await prisma.marketPriceRecommendation.findUnique({ where: { id: rec.id } });
    expect(still!.status).toBe("PENDING");
    expect(await prisma.auditLog.findFirst({ where: { action: "JUNK_PRICE_APPROVED", entityId: rec.id } })).toBeNull();
  });

  it("cross-market approval attempt is rejected (admin not authorised for that market)", async () => {
    const marketA = await makeMarket();
    const marketB = await makeMarket();
    const adminA = await makeAdmin("ADMIN", { marketId: marketA.id }); // only market A
    const recB = await makeRecommendation(marketB.marketCode);
    await expect(approveMarketRecommendation({ recommendationId: recB.id, actingUserId: adminA, actingRole: "ADMIN" }))
      .rejects.toThrow(ForbiddenError);
    const rule = await prisma.pricingRule.findUnique({ where: { marketCode: marketB.marketCode } });
    expect((rule!.junkPriceTable as unknown as { serviceLevels?: unknown }).serviceLevels).toBeUndefined();
  });

  it("wrong role (even with market access) is rejected by the approver-role guard", async () => {
    const market = await makeMarket();
    const notAdmin = await makeAdmin("CUSTOMER", { platform: true }); // market access, wrong role
    const rec = await makeRecommendation(market.marketCode);
    await expect(approveMarketRecommendation({ recommendationId: rec.id, actingUserId: notAdmin, actingRole: "CUSTOMER" }))
      .rejects.toThrow(ApprovalForbiddenError);
  });

  it("market without an owner-approved payment policy cannot have prices approved", async () => {
    const market = await makeMarket({ approvedPolicy: false });
    const admin = await makeAdmin("ADMIN", { platform: true });
    const rec = await makeRecommendation(market.marketCode, { floorPriceCents: 27143, recommendedPriceCents: 37200 });
    await expect(approveMarketRecommendation({ recommendationId: rec.id, actingUserId: admin, actingRole: "ADMIN" }))
      .rejects.toThrow(MarketPolicyNotApprovedError);
  });
});

describe.skipIf(!HAS_DB)("approveLegacyFullServicePricing (DB)", () => {
  it("blesses a market's legacy prices so they become billable Full-Service rates (audited)", async () => {
    const market = await makeMarket({ junkPriceTable: { tiersCents: { HALF: 32900 } } });
    const admin = await makeAdmin("ADMIN", { marketId: market.id });
    // Before: legacy prices are not billable.
    const before = await prisma.pricingRule.findUnique({ where: { marketCode: market.marketCode } });
    expect(resolveApprovedJunkPrice(before!.junkPriceTable, "FULL_SERVICE", { pricingMode: "VOLUME", volumeTier: "HALF" }).approved).toBe(false);

    await approveLegacyFullServicePricing({ marketCode: market.marketCode, actingUserId: admin, actingRole: "ADMIN" });

    const after = await prisma.pricingRule.findUnique({ where: { marketCode: market.marketCode } });
    expect(resolveApprovedJunkPrice(after!.junkPriceTable, "FULL_SERVICE", { pricingMode: "VOLUME", volumeTier: "HALF" }).approved).toBe(true);
    expect(await prisma.auditLog.findFirst({ where: { action: "JUNK_LEGACY_PRICING_APPROVED", entityId: before!.id } })).not.toBeNull();
  });

  it("a cross-market legacy approval is rejected", async () => {
    const marketA = await makeMarket({ junkPriceTable: { tiersCents: { HALF: 32900 } } });
    const marketB = await makeMarket({ junkPriceTable: { tiersCents: { HALF: 32900 } } });
    const adminA = await makeAdmin("ADMIN", { marketId: marketA.id });
    await expect(approveLegacyFullServicePricing({ marketCode: marketB.marketCode, actingUserId: adminA, actingRole: "ADMIN" }))
      .rejects.toThrow(ForbiddenError);
  });

  it("concurrent approvals of the same recommendation also conflict cleanly", async () => {
    // A second guard beyond the duplicate test: a true race must not double-write.
    const market = await makeMarket();
    const admin = await makeAdmin("ADMIN", { marketId: market.id });
    const rec = await makeRecommendation(market.marketCode);
    const results = await Promise.allSettled([
      approveMarketRecommendation({ recommendationId: rec.id, actingUserId: admin, actingRole: "ADMIN" }),
      approveMarketRecommendation({ recommendationId: rec.id, actingUserId: admin, actingRole: "ADMIN" }),
    ]);
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(Error); // ApprovalConflictError or RecommendationNotApprovedError
  });
});
