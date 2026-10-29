import { z } from "zod";

// ---------------------------------------------------------------------------
// Junk removal pricing — VASRUE Digital Media, 28 October 2026.
//
// Built from Carl's junk-removal build spec (11-page revision), §4–§6.
//
// Junk is priced by what is being hauled, never by mover-hour:
//   - VOLUME: a truckload tier (single item through full truck), or
//   - ITEMS: a price per item, for small known jobs (the LoadUp-style instant
//     quote the spec recommends alongside the tiers).
//
// The customer sees ONE all-in price. Disposal is inside it (spec §5b), and so
// is the platform's share: the take-rate comes OUT of the price, it is never
// stacked on top. In this codebase's terms that is DEDUCT_FROM_PROVIDER (see
// FeeModel in lib/pricing.ts) — the behaviour the spec's worked tables and its
// "no customer-visible surcharge" rule describe. The $9.95 booking protection
// is the one amount added on top, exactly as for moving labor.
//
// Every amount is integer cents. The defaults below are the spec's proposed
// Indianapolis prices; a market overrides any of them through the admin pricing
// engine (PricingRule.junkPriceTable). Special-item surcharges default to $0
// because the spec leaves their amounts for Carl to set (§11).
//
// Pure functions only: no database access, safe to import from client code.
// ---------------------------------------------------------------------------

export const JUNK_FEE_MODEL = "DEDUCT_FROM_PROVIDER" as const;

export const JUNK_VOLUME_TIERS = ["SINGLE_ITEM", "EIGHTH", "QUARTER", "HALF", "THREE_QUARTER", "FULL"] as const;
export type JunkVolumeTierCode = (typeof JUNK_VOLUME_TIERS)[number];

export const JUNK_LOCATIONS = ["CURBSIDE", "INSIDE_GROUND", "BASEMENT", "UPSTAIRS"] as const;
export type JunkLocationCode = (typeof JUNK_LOCATIONS)[number];

export const JUNK_PRICING_MODES = ["VOLUME", "ITEMS"] as const;
export type JunkPricingModeCode = (typeof JUNK_PRICING_MODES)[number];

export const JUNK_TIER_INFO: Record<JunkVolumeTierCode, { label: string; guide: string; baseHours: number }> = {
  SINGLE_ITEM: { label: "Single item", guide: "One bulky item, such as a sofa or a fridge", baseHours: 1 },
  EIGHTH: { label: "1/8 truck", guide: "About 2–3 cubic yards: a few pieces of furniture", baseHours: 1 },
  QUARTER: { label: "1/4 truck", guide: "About 4 appliances, or a small room", baseHours: 1.5 },
  HALF: { label: "1/2 truck", guide: "About 4.5–11 cubic yards: a one-car garage", baseHours: 2 },
  THREE_QUARTER: { label: "3/4 truck", guide: "About 11–13 cubic yards: a large room or basement", baseHours: 3 },
  FULL: { label: "Full truck", guide: "Up to about 20 cubic yards: a whole-home cleanout", baseHours: 4 },
};

export const JUNK_LOCATION_LABELS: Record<JunkLocationCode, string> = {
  CURBSIDE: "Curbside or driveway",
  INSIDE_GROUND: "Inside, ground floor",
  BASEMENT: "Basement",
  UPSTAIRS: "Upstairs",
};

// What's being removed (spec §4, step 1). Descriptive only; does not price.
export const JUNK_ITEM_CATEGORIES = {
  FURNITURE: "Furniture",
  APPLIANCE: "Appliances",
  MATTRESS: "Mattresses",
  EWASTE: "Electronics and e-waste",
  YARD_DEBRIS: "Yard debris",
  CONSTRUCTION: "Construction debris",
  HOT_TUB: "Hot tub",
  OTHER: "Something else",
} as const;
export type JunkItemCategoryCode = keyof typeof JUNK_ITEM_CATEGORIES;

// Items that carry extra handling or a disposal fee (spec §6). Selecting one
// adds its surcharge, unless a per-item price already covers it.
export const JUNK_SPECIAL_ITEMS = {
  MATTRESS: "Mattresses or box springs",
  TIRES: "Tires",
  LARGE_APPLIANCE: "Large appliances (recycling fee)",
  EWASTE: "TVs, monitors and other electronics",
  PIANO: "Piano",
  HOT_TUB: "Hot tub",
  FREON_APPLIANCE: "Fridge, freezer or AC unit (refrigerant recovery)",
} as const;
export type JunkSpecialItemCode = keyof typeof JUNK_SPECIAL_ITEMS;

// "We can't take these" (spec §6). Shown to the customer; never bookable.
export const JUNK_PROHIBITED_ITEMS = [
  "Paint, including wet paint",
  "Solvents and chemicals",
  "Asbestos",
  "Biohazard or medical waste",
  "Ammunition",
] as const;

// Per-item price list (spec §5). `covers` names the special-item flag the
// item's own price already accounts for, so it is never surcharged twice.
export const JUNK_ITEMS = {
  MATTRESS: { label: "Mattress or box spring", covers: "MATTRESS" },
  SOFA: { label: "Sofa or couch", covers: null },
  LARGE_FURNITURE: { label: "Dresser, oven or other large furniture", covers: null },
  FRIDGE_FREEZER: { label: "Refrigerator or freezer", covers: "FREON_APPLIANCE" },
  WASHER_DRYER_PAIR: { label: "Washer and dryer (pair)", covers: "LARGE_APPLIANCE" },
  TREADMILL: { label: "Treadmill or exercise equipment", covers: null },
  TV_ELECTRONICS: { label: "TV or electronics", covers: "EWASTE" },
  HOT_TUB: { label: "Hot tub", covers: "HOT_TUB" },
  PIANO_UPRIGHT: { label: "Piano (upright)", covers: "PIANO" },
} as const satisfies Record<string, { label: string; covers: JunkSpecialItemCode | null }>;
export type JunkItemCode = keyof typeof JUNK_ITEMS;

export const JUNK_ITEM_CODES = Object.keys(JUNK_ITEMS) as [JunkItemCode, ...JunkItemCode[]];
export const JUNK_SPECIAL_ITEM_CODES = Object.keys(JUNK_SPECIAL_ITEMS) as [JunkSpecialItemCode, ...JunkSpecialItemCode[]];
export const JUNK_ITEM_CATEGORY_CODES = Object.keys(JUNK_ITEM_CATEGORIES) as [JunkItemCategoryCode, ...JunkItemCategoryCode[]];

export type JunkPriceTable = {
  minimumCents: number;
  tiersCents: Record<JunkVolumeTierCode, number>;
  itemsCents: Record<JunkItemCode, number>;
  surchargesCents: Record<JunkSpecialItemCode, number>;
};

export const DEFAULT_JUNK_PRICE_TABLE: JunkPriceTable = {
  minimumCents: 9900,
  tiersCents: { SINGLE_ITEM: 9900, EIGHTH: 9900, QUARTER: 15900, HALF: 32900, THREE_QUARTER: 49900, FULL: 64900 },
  itemsCents: {
    MATTRESS: 8900, SOFA: 9900, LARGE_FURNITURE: 9900, FRIDGE_FREEZER: 11900, WASHER_DRYER_PAIR: 12900,
    TREADMILL: 14900, TV_ELECTRONICS: 4900, HOT_TUB: 29900, PIANO_UPRIGHT: 19900,
  },
  surchargesCents: { MATTRESS: 0, TIRES: 0, LARGE_APPLIANCE: 0, EWASTE: 0, PIANO: 0, HOT_TUB: 0, FREON_APPLIANCE: 0 },
};

export const DEFAULT_JUNK_TAKE_RATE_PERCENT = 30;
export const DEFAULT_JUNK_HELPER_SHARE_PERCENT = 25;
export const MAX_JUNK_HELPERS = 2;
export const MAX_JUNK_ITEM_QUANTITY = 20;

const cents = z.number().int().min(0).max(1_000_000);

/** What an admin may store in PricingRule.junkPriceTable. Every part is optional; anything left out keeps its default. */
export const junkPriceTableOverrideSchema = z.object({
  minimumCents: cents.optional(),
  tiersCents: z.record(z.enum(JUNK_VOLUME_TIERS), cents).optional(),
  itemsCents: z.record(z.enum(JUNK_ITEM_CODES), cents).optional(),
  surchargesCents: z.record(z.enum(JUNK_SPECIAL_ITEM_CODES), cents).optional(),
}).strict();

/**
 * Merges a stored override over the defaults. A malformed stored value falls
 * back to the defaults entirely rather than pricing from half a table; the
 * admin route validates with the same schema, so that only happens if a row
 * was edited by hand.
 */
export function resolveJunkPriceTable(override: unknown): JunkPriceTable {
  if (override == null) return DEFAULT_JUNK_PRICE_TABLE;
  const parsed = junkPriceTableOverrideSchema.safeParse(override);
  if (!parsed.success) return DEFAULT_JUNK_PRICE_TABLE;
  const o = parsed.data;
  return {
    minimumCents: o.minimumCents ?? DEFAULT_JUNK_PRICE_TABLE.minimumCents,
    tiersCents: { ...DEFAULT_JUNK_PRICE_TABLE.tiersCents, ...o.tiersCents },
    itemsCents: { ...DEFAULT_JUNK_PRICE_TABLE.itemsCents, ...o.itemsCents },
    surchargesCents: { ...DEFAULT_JUNK_PRICE_TABLE.surchargesCents, ...o.surchargesCents },
  };
}

export class JunkQuoteError extends Error {}

export type JunkQuoteInput = {
  table: JunkPriceTable;
  takeRatePercent: number;
  helperSharePercent: number;
  bookingProtectionCents: number;
  pricingMode: JunkPricingModeCode;
  volumeTier?: JunkVolumeTierCode | null;
  items?: { code: JunkItemCode; quantity: number }[] | null;
  specialItems: JunkSpecialItemCode[];
  itemLocation: JunkLocationCode;
  hasHeavyItems: boolean;
};

export type JunkQuoteLine = { label: string; cents: number };

export type JunkQuote = {
  feeModel: typeof JUNK_FEE_MODEL;
  pricingMode: JunkPricingModeCode;
  servicePriceCents: number;
  surchargesCents: number;
  allInCents: number;
  takeRatePercent: number;
  platformTakeCents: number;
  crewPoolCents: number;
  helpersRequired: number;
  crewSize: number;
  helperSharePercent: number;
  haulerShareCents: number;
  helperShareCents: number;
  bookingProtectionFeeCents: number;
  totalCents: number;
  estimatedHours: number;
  lines: JunkQuoteLine[];
};

/** The customer-facing part of a quote: one all-in price and its lines. The crew split is internal. */
export function toPublicJunkQuote(quote: JunkQuote) {
  const { platformTakeCents: _take, crewPoolCents: _pool, haulerShareCents: _h, helperShareCents: _hs, takeRatePercent: _t, helperSharePercent: _p, ...publicQuote } = quote;
  return publicQuote;
}

/** How big the job is on the tier scale (0 = single item … 5 = full truck). */
export function sizeRank(input: Pick<JunkQuoteInput, "pricingMode" | "volumeTier" | "items">): number {
  if (input.pricingMode === "VOLUME") return JUNK_VOLUME_TIERS.indexOf(input.volumeTier as JunkVolumeTierCode);
  const count = (input.items ?? []).reduce((n, i) => n + i.quantity, 0);
  if (count <= 1) return 0;
  if (count <= 3) return 2;
  if (count <= 8) return 3;
  return 4;
}

export function isHardJob(input: Pick<JunkQuoteInput, "itemLocation" | "hasHeavyItems" | "specialItems">): boolean {
  return input.hasHeavyItems
    || input.itemLocation === "BASEMENT" || input.itemLocation === "UPSTAIRS"
    || input.specialItems.includes("PIANO") || input.specialItems.includes("HOT_TUB");
}

/**
 * Crew size from volume and difficulty (spec §4, step 2): the hauler always,
 * plus helpers. A small curbside pickup with nothing heavy is a one-person
 * job; anything inside, heavy, or bigger needs a second pair of hands; a
 * large load that is also heavy or below/above ground gets two helpers.
 */
export function junkHelpersRequired(input: Pick<JunkQuoteInput, "itemLocation" | "hasHeavyItems" | "specialItems"> & { rank: number }): number {
  const hard = isHardJob(input);
  if (input.rank <= 1 && !hard && input.itemLocation === "CURBSIDE") return 0;
  if (input.rank >= 4 && hard) return 2;
  return 1;
}

export function calculateJunkQuote(input: JunkQuoteInput): JunkQuote {
  const { table } = input;
  if (!Number.isInteger(input.takeRatePercent) || input.takeRatePercent < 0 || input.takeRatePercent > 100) {
    throw new JunkQuoteError("Take-rate must be a whole percentage between 0 and 100.");
  }
  if (!Number.isInteger(input.helperSharePercent) || input.helperSharePercent < 0 || input.helperSharePercent * MAX_JUNK_HELPERS > 90) {
    throw new JunkQuoteError("Helper share must leave the hauler at least 10% of the crew's pay.");
  }

  const lines: JunkQuoteLine[] = [];
  let baseCents = 0;
  const covered = new Set<JunkSpecialItemCode>();

  if (input.pricingMode === "VOLUME") {
    if (!input.volumeTier || !JUNK_VOLUME_TIERS.includes(input.volumeTier)) throw new JunkQuoteError("Choose how much there is to haul.");
    baseCents = table.tiersCents[input.volumeTier];
    lines.push({ label: `${JUNK_TIER_INFO[input.volumeTier].label}: hauling and disposal`, cents: baseCents });
  } else {
    const items = input.items ?? [];
    if (items.length === 0) throw new JunkQuoteError("Add at least one item.");
    for (const item of items) {
      if (!(item.code in JUNK_ITEMS)) throw new JunkQuoteError(`Unknown item: ${item.code}.`);
      if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > MAX_JUNK_ITEM_QUANTITY) {
        throw new JunkQuoteError(`Quantity must be between 1 and ${MAX_JUNK_ITEM_QUANTITY}.`);
      }
      const lineCents = table.itemsCents[item.code] * item.quantity;
      baseCents += lineCents;
      const def = JUNK_ITEMS[item.code];
      if (def.covers) covered.add(def.covers);
      lines.push({ label: `${def.label}${item.quantity > 1 ? ` × ${item.quantity}` : ""}`, cents: lineCents });
    }
  }

  // The minimum is the floor (spec §5): a tiny item-priced job still pays it.
  const servicePriceCents = Math.max(table.minimumCents, baseCents);
  if (servicePriceCents > baseCents) lines.push({ label: "Minimum charge adjustment", cents: servicePriceCents - baseCents });

  let surchargesCents = 0;
  for (const code of new Set(input.specialItems)) {
    if (!(code in JUNK_SPECIAL_ITEMS)) throw new JunkQuoteError(`Unknown special item: ${code}.`);
    if (covered.has(code)) continue;
    const s = table.surchargesCents[code] ?? 0;
    if (s > 0) lines.push({ label: `Special handling: ${JUNK_SPECIAL_ITEMS[code]}`, cents: s });
    surchargesCents += s;
  }

  const allInCents = servicePriceCents + surchargesCents;
  const platformTakeCents = Math.round((allInCents * input.takeRatePercent) / 100);
  const crewPoolCents = allInCents - platformTakeCents;

  const rank = sizeRank(input);
  const helpersRequired = junkHelpersRequired({ ...input, rank });
  const helperShareCents = helpersRequired > 0 ? Math.floor((crewPoolCents * input.helperSharePercent) / 100) : 0;
  // The hauler takes the remainder, so rounding never loses or invents a cent.
  const haulerShareCents = crewPoolCents - helperShareCents * helpersRequired;

  const estimatedHours = JUNK_TIER_INFO[JUNK_VOLUME_TIERS[Math.max(0, rank)]].baseHours + (isHardJob(input) ? 1 : 0);

  lines.push({ label: "Booking protection", cents: input.bookingProtectionCents });

  return {
    feeModel: JUNK_FEE_MODEL,
    pricingMode: input.pricingMode,
    servicePriceCents,
    surchargesCents,
    allInCents,
    takeRatePercent: input.takeRatePercent,
    platformTakeCents,
    crewPoolCents,
    helpersRequired,
    crewSize: 1 + helpersRequired,
    helperSharePercent: input.helperSharePercent,
    haulerShareCents,
    helperShareCents,
    bookingProtectionFeeCents: input.bookingProtectionCents,
    totalCents: allInCents + input.bookingProtectionCents,
    estimatedHours,
    lines,
  };
}
