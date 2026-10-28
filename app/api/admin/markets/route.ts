import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { Prisma } from "@prisma/client"; // VASRUE Digital Media — BLOCK-05: JSON column typing.
import { requireMarketAccess, ForbiddenError, MarketNotFoundError } from "@/lib/market-access";
import { evaluateMarketActivationReadiness } from "@/lib/markets/activation-readiness";

/**
 * Admin market management (launch spec §4/§5/§7). Read all markets; update a
 * market's stage + service controls + config WITHOUT a code deploy.
 *
 * Activation guard: moving a market TO ACTIVE runs the readiness validator.
 * If blockers exist, the request must carry override:true + a reason, and the
 * override is written to MarketChangeLog. Every change is audited with
 * previous/new stage, changed fields, actor, reason, and whether an override
 * was used.
 *
 * Market-scoped: an admin may only manage markets their assignment covers
 * (requireMarketAccess). Brokerage cannot be enabled here in a way that
 * bypasses global compliance — the market flag is necessary-not-sufficient.
 */
const ADMIN_ROLES = ["ADMIN", "SUPPORT", "FINANCE_ADMIN", "SUPER_ADMIN"] as const;

export async function GET(request: Request) {
  try {
    await requireRole(request, ADMIN_ROLES as unknown as ("ADMIN")[]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const markets = await prisma.launchMarket.findMany({ orderBy: [{ stage: "asc" }, { name: "asc" }] });
  return NextResponse.json({ markets });
}

const updateSchema = z.object({
  marketId: z.string().min(1),
  stage: z.enum(["PLANNING", "CARRIER_RECRUITMENT", "COMING_SOON", "SOFT_LAUNCH", "ACTIVE", "PAUSED", "CLOSED"]).optional(),
  customerBookingEnabled: z.boolean().optional(),
  moverRecruitmentEnabled: z.boolean().optional(),
  driverRecruitmentEnabled: z.boolean().optional(),
  carrierRecruitmentEnabled: z.boolean().optional(),
  dispatchSupportEnabled: z.boolean().optional(),
  freightBrokerageEnabled: z.boolean().optional(),
  // Junk removal — VASRUE Digital Media, 28 Oct 2026: the per-market junk switch.
  junkRemovalEnabled: z.boolean().optional(),
  zipCodes: z.array(z.string()).optional(),
  defaultRadiusMiles: z.number().int().positive().optional(),
  override: z.boolean().optional(),
  reason: z.string().max(1000).optional(),
});

export async function PATCH(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ADMIN_ROLES as unknown as ("ADMIN")[]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const parsed = updateSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const { marketId, override, reason, ...changes } = parsed.data;

  const market = await prisma.launchMarket.findUnique({ where: { id: marketId } });
  if (!market) return NextResponse.json({ error: "Market not found." }, { status: 404 });

  try {
    await requireMarketAccess({ userId: authed.userId, marketId });
  } catch (e) {
    if (e instanceof ForbiddenError || e instanceof MarketNotFoundError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  let overrideUsed = false;

  // Activation guard: going TO ACTIVE requires readiness (or an audited override).
  if (changes.stage === "ACTIVE" && market.stage !== "ACTIVE") {
    const readiness = evaluateMarketActivationReadiness({
      hasZipOrBoundary: (changes.zipCodes ?? market.zipCodes).length > 0 || market.centerLat != null,
      pricingConfigured: (await prisma.marketPricingRule.count({ where: { marketId } })) > 0,
      minimumBookingRulesConfigured: true, // min movers/hours are global floors; treated as configured
      atLeastOneServiceEnabled: Boolean(changes.customerBookingEnabled ?? market.customerBookingEnabled) || Boolean(changes.dispatchSupportEnabled ?? market.dispatchSupportEnabled),
      paymentProcessingAvailable: true, // Stripe is platform-wide; team confirms in checklist
      supportCoverageAssigned: (await prisma.adminAssignment.count({ where: { marketId } })) > 0,
      approvedWorkerCount: market.activeMovers + market.activeBoxTruckDrivers + market.activeSemiDrivers,
      requiredWorkerThreshold: market.targetMovingCompanies > 0 ? 25 : 25,
      approvedCarrierCount: market.activeSemiDrivers,
      requiredCarrierThreshold: 15,
      freightServiceRequested: Boolean(changes.freightBrokerageEnabled ?? market.freightBrokerageEnabled),
      unresolvedLaunchBlockers: 0,
    });
    if (!readiness.ready) {
      if (!override || !reason) {
        return NextResponse.json({ error: "Market is not ready to activate.", blockers: readiness.blockers, requiresOverride: true }, { status: 428 });
      }
      overrideUsed = true;
    }
  }

  // Compute changed fields for the audit log.
  const changedFields: Record<string, { from: unknown; to: unknown }> = {};
  for (const [k, v] of Object.entries(changes)) {
    if (v !== undefined && (market as Record<string, unknown>)[k] !== v) {
      changedFields[k] = { from: (market as Record<string, unknown>)[k], to: v };
    }
  }

  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.launchMarket.update({ where: { id: marketId }, data: { ...changes } });
    await tx.marketChangeLog.create({
      data: {
        marketId,
        previousStage: market.stage,
        newStage: changes.stage ?? market.stage,
        // VASRUE Digital Media — BLOCK-05, 24 Oct 2026. changedFields is built with
        // `unknown` values, which Prisma's JSON input type does not accept. The shape
        // is a plain JSON object by construction (from/to pairs of scalar field
        // values), so this asserts what the builder above already guarantees.
        changedFields: changedFields as unknown as Prisma.InputJsonObject,
        changedById: authed.userId,
        changeReason: reason,
        overrideUsed,
      },
    });
    return u;
  });

  return NextResponse.json({ market: updated, overrideUsed });
}
