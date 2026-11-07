import { z } from "zod";
import {
  JUNK_ITEM_CATEGORY_CODES, JUNK_ITEM_CODES, JUNK_LOCATIONS, JUNK_PRICING_MODES, JUNK_SERVICE_LEVELS,
  JUNK_SPECIAL_ITEM_CODES, JUNK_VOLUME_TIERS, MAX_JUNK_ITEM_QUANTITY, DEFAULT_JUNK_SERVICE_LEVEL,
} from "@/lib/junk/pricing";

// Junk removal — VASRUE Digital Media, 28 October 2026. The job-details shape
// shared by the quote and booking routes, so the price a customer is shown and
// the price they book are computed from identically-validated input.
export const junkJobDetailsSchema = z.object({
  pricingMode: z.enum(JUNK_PRICING_MODES),
  volumeTier: z.enum(JUNK_VOLUME_TIERS).nullish(),
  items: z.array(z.object({
    code: z.enum(JUNK_ITEM_CODES),
    quantity: z.number().int().min(1).max(MAX_JUNK_ITEM_QUANTITY),
  })).max(JUNK_ITEM_CODES.length).nullish(),
  itemCategories: z.array(z.enum(JUNK_ITEM_CATEGORY_CODES)).max(JUNK_ITEM_CATEGORY_CODES.length).default([]),
  specialItems: z.array(z.enum(JUNK_SPECIAL_ITEM_CODES)).max(JUNK_SPECIAL_ITEM_CODES.length).default([]),
  itemLocation: z.enum(JUNK_LOCATIONS),
  hasHeavyItems: z.boolean().default(false),
  serviceLevel: z.enum(JUNK_SERVICE_LEVELS).default(DEFAULT_JUNK_SERVICE_LEVEL),
}).superRefine((v, ctx) => {
  if (v.pricingMode === "VOLUME" && !v.volumeTier) ctx.addIssue({ code: "custom", path: ["volumeTier"], message: "Choose how much there is to haul." });
  if (v.pricingMode === "ITEMS" && !(v.items && v.items.length > 0)) ctx.addIssue({ code: "custom", path: ["items"], message: "Add at least one item." });
  if (v.items && new Set(v.items.map((i) => i.code)).size !== v.items.length) ctx.addIssue({ code: "custom", path: ["items"], message: "List each item once, with a quantity." });
});

export type JunkJobDetailsInput = z.infer<typeof junkJobDetailsSchema>;
