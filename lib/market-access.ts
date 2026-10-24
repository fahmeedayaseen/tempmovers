import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import { hasMarketAccess, type Assignment } from "@/lib/market-access-policy";

export class ForbiddenError extends Error {
  status = 403;
  constructor(message = "You do not have access to this market.") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export class MarketNotFoundError extends Error {
  status = 404;
  constructor(message = "Market not found.") {
    super(message);
    this.name = "MarketNotFoundError";
  }
}

/**
 * The single source of truth for market authorization. Verifies that a user
 * has admin access to a given market (and optionally a specific territory)
 * across ALL scopes — PLATFORM, STATE, MARKET, TERRITORY — with the STATE
 * scope now fully resolved inside the helper (it looks up the market's state
 * itself, so no call site has to). Throws rather than returning a boolean so
 * a call site can't accidentally ignore a denial.
 *
 * Call at the top of any market-scoped route/mutation (pricing, settlements,
 * loads, jobs, workers, partners, admin, reports, accessorial pricing) before
 * doing anything else.
 */
export async function requireMarketAccess({
  userId,
  marketId,
  territoryId,
}: {
  userId: string;
  marketId: string;
  territoryId?: string | null;
}): Promise<void> {
  // Resolve the market's state so STATE-scope assignments can be evaluated
  // here rather than deferred to (and forgotten by) each call site.
  const market = await prisma.launchMarket.findUnique({
    where: { id: marketId },
    select: { id: true, state: true },
  });
  if (!market) throw new MarketNotFoundError();

  const assignments = (await prisma.adminAssignment.findMany({
    where: { userId, active: true },
    select: { scope: true, state: true, marketId: true, territoryId: true, active: true },
  })) as Assignment[];

  const allowed = hasMarketAccess(assignments, { marketId: market.id, state: market.state, territoryId: territoryId ?? null });
  if (!allowed) throw new ForbiddenError();
}

/**
 * Non-throwing variant for places that need a boolean (e.g. filtering a list
 * of markets a user may see). Same policy, no exception.
 */
export async function checkMarketAccess(params: { userId: string; marketId: string; territoryId?: string | null }): Promise<boolean> {
  try {
    await requireMarketAccess(params);
    return true;
  } catch (e) {
    if (e instanceof ForbiddenError) return false;
    throw e; // a genuine not-found / DB error should surface
  }
}

/**
 * Partition a set of market-scoped records into authorized vs skipped, for
 * PARTIAL settlement by authorization scope (settlement handoff, Option 1).
 * Uses the same market-access policy as everything else — no separate
 * settlement permission. A record with no resolvable market is treated as
 * unauthorized (fail closed) unless the user is PLATFORM scope.
 *
 * Records must expose their market id + state + optional territory. Returns
 * the authorized records and a per-market skipped summary so the caller can
 * report exactly what was excluded and why (never silently omit).
 */
export type ScopedRecord<T> = { record: T; marketId: string | null; marketState: string | null; marketLabel: string | null; territoryId?: string | null };

export async function partitionByMarketAccess<T>(
  userId: string,
  records: ScopedRecord<T>[],
  client: typeof prisma | Prisma.TransactionClient = prisma,
): Promise<{ authorized: T[]; skipped: { marketLabel: string; count: number }[] }> {
  const assignments = (await client.adminAssignment.findMany({
    where: { userId, active: true },
    select: { scope: true, state: true, marketId: true, territoryId: true, active: true },
  })) as Assignment[];

  const authorized: T[] = [];
  const skippedByMarket = new Map<string, number>();

  for (const r of records) {
    // Fail closed: a record with no resolvable market is only settleable by a
    // platform-scope admin.
    const target = r.marketId && r.marketState != null
      ? { marketId: r.marketId, state: r.marketState, territoryId: r.territoryId ?? null }
      : null;
    const allowed = target
      ? hasMarketAccess(assignments, target)
      : assignments.some((a) => a.scope === "PLATFORM" && a.active !== false);

    if (allowed) {
      authorized.push(r.record);
    } else {
      const label = r.marketLabel ?? r.marketId ?? "Unknown market";
      skippedByMarket.set(label, (skippedByMarket.get(label) ?? 0) + 1);
    }
  }

  const skipped = [...skippedByMarket.entries()].map(([marketLabel, count]) => ({ marketLabel, count }));
  return { authorized, skipped };
}

/**
 * Authorize a route that is keyed by marketCode (e.g. PricingRule) rather than
 * a LaunchMarket id. Resolves the code to a LaunchMarket and authorizes
 * against it. If NO market matches the code — a national/default rule such as
 * "US-DEFAULT" — this is platform-level configuration, so it requires a
 * PLATFORM-scope assignment (fail closed: a market/state/territory admin
 * cannot edit platform-wide defaults).
 */
export async function requireMarketAccessByCode({
  userId,
  marketCode,
}: {
  userId: string;
  marketCode: string;
}): Promise<void> {
  const market = await prisma.launchMarket.findUnique({ where: { marketCode }, select: { id: true } });
  if (market) {
    await requireMarketAccess({ userId, marketId: market.id });
    return;
  }
  // No market for this code → platform-level default. Require PLATFORM scope.
  const platform = await prisma.adminAssignment.findFirst({
    where: { userId, active: true, scope: "PLATFORM" },
    select: { id: true },
  });
  if (!platform) throw new ForbiddenError("Editing platform-default pricing requires platform-level access.");
}
