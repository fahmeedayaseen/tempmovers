/**
 * Accessorial engine — DB-backed price resolution (P0). Thin wrapper over the
 * pure resolver: fetches candidate published rows for an accessorial and
 * hands them to resolvePriceRow. Server-side only.
 */
import { prisma } from "@/lib/db";
import { resolvePriceRow, hasOverlap, type PriceRow } from "@/lib/accessorials/resolver";

export async function resolveAccessorialPrice(accessorialTypeId: string, marketId: string | null, at: Date) {
  const rows = await prisma.accessorialMarketPrice.findMany({
    where: { accessorialTypeId, isPublished: true, OR: [{ marketId }, { marketId: null }] },
  });
  const asPriceRows: PriceRow[] = rows.map(r => ({ id: r.id, marketId: r.marketId, effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo, isPublished: r.isPublished, version: r.version }));
  const picked = resolvePriceRow(asPriceRows, marketId, at);
  if (!picked) return null;
  return rows.find(r => r.id === picked.id) ?? null;
}

/**
 * Would a proposed effective range overlap an existing row for the same
 * (accessorialType, market)? Fetches siblings and delegates to the pure
 * hasOverlap. excludeId lets an update ignore itself.
 */
export async function wouldOverlap(accessorialTypeId: string, marketId: string | null, effectiveFrom: Date, effectiveTo: Date | null, excludeId?: string): Promise<boolean> {
  const siblings = await prisma.accessorialMarketPrice.findMany({
    where: { accessorialTypeId, marketId },
    select: { id: true, effectiveFrom: true, effectiveTo: true },
  });
  return hasOverlap(siblings, { id: excludeId, effectiveFrom, effectiveTo });
}
