import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { requireMarketAccessByCode, ForbiddenError } from "@/lib/market-access";
import { Prisma } from "@prisma/client";
import { junkPriceTableOverrideSchema } from "@/lib/junk/pricing";

const schema = z.object({
  marketCode: z.string().default("US-DEFAULT"),
  moverSubscriptionCents: z.number().int().nonnegative().optional(),
  driverBasicSubscriptionCents: z.number().int().nonnegative().optional(),
  ownerOperatorSubscriptionCents: z.number().int().nonnegative().optional(),
  fleetSubscriptionCents: z.number().int().nonnegative().optional(),
  additionalFleetVehicleCents: z.number().int().nonnegative().optional(),
  boxTruckFeePerHourCents: z.number().int().nonnegative().optional(),
  semiPlatformFeePercent: z.number().int().min(0).max(100).optional(),
  semiPlatformFeeCapCents: z.number().int().nonnegative().optional(),
  // Fee MODEL per freight service type — admin-selectable so pricing can
  // change with the market without a code change. Moving labor and local
  // box-truck jobs are always ADD_TO_CUSTOMER and are intentionally not
  // togglable here.
  semiFeeModel: z.enum(["ADD_TO_CUSTOMER", "DEDUCT_FROM_PROVIDER"]).optional(),
  freightBoxTruckFeeModel: z.enum(["ADD_TO_CUSTOMER", "DEDUCT_FROM_PROVIDER"]).optional(),
  platformFeePerHourCents: z.number().int().nonnegative().optional(),
  urgentPlatformFeePerHourCents: z.number().int().nonnegative().optional(),
  customerBookingProtectionFeeCents: z.number().int().nonnegative().optional(),
  // Minimums are intentionally NOT editable below the approved floor from here —
  // this endpoint can raise minimumMovers/minimumHours but never below 2 / 3.
  minimumMovers: z.number().int().min(2).optional(),
  minimumHours: z.number().min(3).optional(),
  // Junk removal — VASRUE Digital Media, 28 Oct 2026. The take-rate is the platform's share
  // of the all-in junk price; each helper's share is a cut of the crew's part,
  // capped so the hauler always keeps the larger share. junkPriceTable
  // overrides any tier, item or surcharge price (integer cents); null resets
  // the market to the defaults in lib/junk/pricing.ts.
  junkTakeRatePercent: z.number().int().min(0).max(100).optional(),
  junkHelperSharePercent: z.number().int().min(0).max(45).optional(),
  junkPriceTable: junkPriceTableOverrideSchema.nullable().optional(),
});

export async function GET(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["ADMIN", "SUPPORT", "FINANCE_ADMIN", "SUPER_ADMIN"] as unknown as ("ADMIN")[]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { searchParams } = new URL(request.url);
  const marketCode = searchParams.get("marketCode") ?? "US-DEFAULT";
  // Market-scoped read: enforce access to this market's pricing.
  try {
    await requireMarketAccessByCode({ userId: authed.userId, marketCode });
  } catch (e) {
    if (e instanceof ForbiddenError) return NextResponse.json({ error: e.message }, { status: 403 });
    throw e;
  }
  const rule = await prisma.pricingRule.findUnique({ where: { marketCode } });
  if (!rule) return NextResponse.json({ error: "No pricing rule for that market." }, { status: 404 });
  return NextResponse.json({ pricing: rule });
}

export async function PUT(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["ADMIN", "FINANCE_ADMIN", "SUPER_ADMIN"] as unknown as ("ADMIN")[]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const { marketCode, junkPriceTable, ...rest } = parsed.data;
  const updates = {
    ...rest,
    ...(junkPriceTable !== undefined && { junkPriceTable: junkPriceTable === null ? Prisma.DbNull : junkPriceTable }),
  };

  // Market-scoped write: enforce access to THIS market's pricing (or platform
  // scope for the national default). Resolve-from-record, fail closed.
  try {
    await requireMarketAccessByCode({ userId: authed.userId, marketCode });
  } catch (e) {
    if (e instanceof ForbiddenError) return NextResponse.json({ error: e.message }, { status: 403 });
    throw e;
  }

  const rule = await prisma.pricingRule.upsert({
    where: { marketCode },
    update: updates,
    create: { marketCode, ...updates },
  });

  await prisma.auditLog.create({
    data: { actorId: authed.userId, action: "PRICING_UPDATED", entityType: "PricingRule", entityId: rule.id, details: { marketCode, ...rest, ...(junkPriceTable !== undefined && { junkPriceTable }) } },
  });

  return NextResponse.json({ pricing: rule });
}
