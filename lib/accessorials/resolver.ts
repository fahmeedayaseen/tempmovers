/**
 * Accessorial engine — PURE resolver + overlap logic (P0). The DB layer
 * fetches candidate AccessorialMarketPrice rows; these pure functions decide
 * WHICH row applies and whether a proposed row's date range is legal. No DB
 * here, so both are unit-testable.
 */

export type PriceRow = {
  id: string;
  marketId: string | null; // null = national fallback
  effectiveFrom: Date;
  effectiveTo: Date | null; // null = open-ended
  isPublished: boolean;
  version: number;
};

/** Is `at` within [effectiveFrom, effectiveTo)? Open-ended when effectiveTo is null. */
export function isEffectiveAt(row: Pick<PriceRow, "effectiveFrom" | "effectiveTo">, at: Date): boolean {
  if (at.getTime() < row.effectiveFrom.getTime()) return false;
  if (row.effectiveTo != null && at.getTime() >= row.effectiveTo.getTime()) return false;
  return true;
}

/**
 * Select the price row for a booking. Prefers a published row for the
 * booking's market that is effective at `at`; falls back to the national row
 * (marketId === null). Returns null when neither exists (caller errors rather
 * than guessing a price). Because overlapping ranges are prevented on write,
 * at most one row per market matches — but if somehow more than one does, the
 * highest version wins (deterministic).
 */
export function resolvePriceRow(rows: PriceRow[], marketId: string | null, at: Date): PriceRow | null {
  const eligible = rows.filter(r => r.isPublished && isEffectiveAt(r, at));
  const pick = (mid: string | null) =>
    eligible.filter(r => r.marketId === mid).sort((a, b) => b.version - a.version)[0] ?? null;
  // Market-specific first, then national fallback.
  if (marketId != null) {
    const m = pick(marketId);
    if (m) return m;
  }
  return pick(null);
}

/**
 * Would a proposed [from, to) range overlap any existing row for the SAME
 * (accessorialType, market)? Used server-side to reject overlapping ranges.
 * Ranges are half-open: touching at an endpoint (to == other.from) is NOT an
 * overlap. An open-ended existing row (to null) extends to infinity.
 */
export function hasOverlap(
  existing: { effectiveFrom: Date; effectiveTo: Date | null; id?: string }[],
  proposed: { effectiveFrom: Date; effectiveTo: Date | null; id?: string },
): boolean {
  const pFrom = proposed.effectiveFrom.getTime();
  const pTo = proposed.effectiveTo ? proposed.effectiveTo.getTime() : Infinity;
  for (const e of existing) {
    if (proposed.id && e.id && e.id === proposed.id) continue; // ignore self on update
    const eFrom = e.effectiveFrom.getTime();
    const eTo = e.effectiveTo ? e.effectiveTo.getTime() : Infinity;
    // Half-open overlap test: [pFrom,pTo) ∩ [eFrom,eTo) ≠ ∅
    if (pFrom < eTo && eFrom < pTo) return true;
  }
  return false;
}
