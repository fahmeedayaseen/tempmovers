import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { requireMarketAccess, ForbiddenError, MarketNotFoundError } from "@/lib/market-access";
import { isRateWithinBand } from "@/lib/accessorials/compute";

/**
 * Admin accessorial market-price rows (P0) — the per-market, effective-dated
 * pricing. POST creates a row with three safeguards:
 *   1. BAND: customerRateCents must be within [minimumPrice, maximumPrice].
 *      A normal ADMIN is rejected if out of band; only FINANCE_ADMIN /
 *      SUPER_ADMIN may override, and only WITH a non-empty reason, which is
 *      recorded on the row and in an audit entry.
 *   2. OVERLAP: the [effectiveFrom, effectiveTo) range must not overlap an
 *      existing row for the same (accessorialType, market).
 *   3. National fallback is just marketId = null; nothing special to do here.
 * Rows are created unpublished by default; publishing is a separate action so
 * an admin can preview which row will go live (build step 7).
 */
const schema = z.object({
  accessorialTypeId: z.string().cuid(),
  marketId: z.string().cuid().nullable().optional(), // null = national
  customerRateCents: z.number().int().nonnegative(),
  defaultSuggestedPrice: z.number().int().nonnegative().nullable().optional(),
  recommendedPrice: z.number().int().nonnegative().nullable().optional(),
  minimumPrice: z.number().int().nonnegative().nullable().optional(),
  maximumPrice: z.number().int().nonnegative().nullable().optional(),
  effectiveFrom: z.string().datetime(),
  effectiveTo: z.string().datetime().nullable().optional(),
  bandOverrideReason: z.string().min(1).max(500).optional(),
  isPublished: z.boolean().optional(),
});

const PRIVILEGED = new Set(["FINANCE_ADMIN", "SUPER_ADMIN"]);

export async function POST(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["ADMIN", "FINANCE_ADMIN", "SUPER_ADMIN"] as unknown as ("ADMIN")[]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const d = parsed.data;

  // Market-scoped authorization: a per-market price requires access to THAT
  // market; a national (marketId null) price is platform-level config and
  // requires PLATFORM scope. Fail closed. Mirrors the pricing route.
  try {
    if (d.marketId) {
      await requireMarketAccess({ userId: authed.userId, marketId: d.marketId });
    } else {
      const platform = await prisma.adminAssignment.findFirst({ where: { userId: authed.userId, active: true, scope: "PLATFORM" }, select: { id: true } });
      if (!platform) return NextResponse.json({ error: "Editing national (default) accessorial pricing requires platform-level access." }, { status: 403 });
    }
  } catch (e) {
    if (e instanceof ForbiddenError || e instanceof MarketNotFoundError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  if (d.minimumPrice != null && d.maximumPrice != null && d.minimumPrice > d.maximumPrice) {
    return NextResponse.json({ error: "minimumPrice cannot exceed maximumPrice." }, { status: 400 });
  }
  const from = new Date(d.effectiveFrom);
  const to = d.effectiveTo ? new Date(d.effectiveTo) : null;
  if (to && to.getTime() <= from.getTime()) {
    return NextResponse.json({ error: "effectiveTo must be after effectiveFrom." }, { status: 400 });
  }

  // 1. Band check + role-based override.
  const withinBand = isRateWithinBand(d.customerRateCents, d.minimumPrice, d.maximumPrice);
  let bandOverride = false;
  if (!withinBand) {
    const isPrivileged = PRIVILEGED.has(authed.role);
    if (!isPrivileged) {
      return NextResponse.json({ error: "customerRateCents is outside the configured band. Only a Finance or Super Admin can override." }, { status: 422 });
    }
    if (!d.bandOverrideReason) {
      return NextResponse.json({ error: "A band-override reason is required to set a rate outside the band." }, { status: 422 });
    }
    bandOverride = true;
  }

  // 2. Overlap check + create, atomic under Serializable isolation so two
  // concurrent creates can't both pass the check and insert overlapping rows.
  let row;
  try {
    row = await prisma.$transaction(async (tx) => {
      const siblings = await tx.accessorialMarketPrice.findMany({
        where: { accessorialTypeId: d.accessorialTypeId, marketId: d.marketId ?? null },
        select: { id: true, effectiveFrom: true, effectiveTo: true },
      });
      const { hasOverlap } = await import("@/lib/accessorials/resolver");
      if (hasOverlap(siblings, { effectiveFrom: from, effectiveTo: to })) {
        throw new Error("OVERLAP");
      }
      const latest = await tx.accessorialMarketPrice.findFirst({
        where: { accessorialTypeId: d.accessorialTypeId, marketId: d.marketId ?? null },
        orderBy: { version: "desc" }, select: { version: true },
      });
      return tx.accessorialMarketPrice.create({
        data: {
          accessorialTypeId: d.accessorialTypeId,
          marketId: d.marketId ?? null,
          customerRateCents: d.customerRateCents,
          defaultSuggestedPrice: d.defaultSuggestedPrice ?? null,
          recommendedPrice: d.recommendedPrice ?? null,
          minimumPrice: d.minimumPrice ?? null,
          maximumPrice: d.maximumPrice ?? null,
          effectiveFrom: from, effectiveTo: to,
          version: (latest?.version ?? 0) + 1,
          bandOverride, bandOverrideReason: bandOverride ? d.bandOverrideReason : null,
          isPublished: d.isPublished ?? false,
          createdByUserId: authed.userId,
        },
      });
    }, { isolationLevel: "Serializable" });
  } catch (e) {
    if (e instanceof Error && e.message === "OVERLAP") {
      return NextResponse.json({ error: "This effective-date range overlaps an existing price for the same market." }, { status: 409 });
    }
    throw e;
  }

  await prisma.auditLog.create({
    data: {
      actorId: authed.userId,
      action: bandOverride ? "ACCESSORIAL_PRICE_CREATED_BAND_OVERRIDE" : "ACCESSORIAL_PRICE_CREATED",
      entityType: "AccessorialMarketPrice",
      entityId: row.id,
      details: { accessorialTypeId: d.accessorialTypeId, marketId: d.marketId ?? null, customerRateCents: d.customerRateCents, bandOverride, reason: bandOverride ? d.bandOverrideReason : null },
    },
  });

  return NextResponse.json({ price: row }, { status: 201 });
}
