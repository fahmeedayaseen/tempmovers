import type { CompetitorObservationInput } from "@/lib/junk/market-intelligence";

// ---------------------------------------------------------------------------
// Verified competitor observations — Phase 1 seed (re-verified 7 November 2026)
//
// MANUALLY collected and INDEPENDENTLY VERIFIED (directive §3, owner
// authorization §2, correction handoff BLOCKER 6). Every row below was opened
// and its advertised price read directly from the competitor's own local page
// on 2026-11-07; see VERIFICATION_LOG for the per-URL record. No scraping;
// scheduled collection is Phase 2.
//
// INTEGRITY RULES APPLIED:
//  - Only prices published on a competitor's OWN local page for a specific
//    nearby city are recorded, all as MEDIUM confidence (item-level, local).
//  - National averages and comparison-blog figures are NOT stored as local
//    quotes. The earlier draft's invented national full-service truckload
//    figures ($400 / $650) were REMOVED — they could not be verified as local.
//  - Disposal is assumed included only where the page states it explicitly.
//
// Net effect: the only benchmarkable data today are verified LoadUp / Dropcurb
// local curbside single-item prices, all of which sit BELOW the Economy
// single-item cost floor ($92.86) — so the engine rejects the discount
// (FLOOR_HELD). Verified LOCAL full-service and disposal costs remain an owner
// blocker (directive §7); there is no full-service benchmark in this seed.
// ---------------------------------------------------------------------------

export type SeededCompetitorObservation = CompetitorObservationInput & {
  marketCode: string;
  zipCode?: string;
  sourceUrl: string;
  conditions?: string;
};

// Verification date (each page opened and price read on this date).
const OBSERVED = new Date("2026-11-07T00:00:00.000Z");

export const COMPETITOR_OBSERVATIONS: SeededCompetitorObservation[] = [
  // --- Indianapolis Metro (INDY) -------------------------------------------
  {
    marketCode: "INDY",
    zipCode: "46204",
    competitor: "LoadUp",
    sourceUrl: "https://goloadup.com/indianapolis/",
    observedAt: OBSERVED,
    serviceType: "CURBSIDE",
    pricingBasis: "ITEM",
    comparableTier: null,
    includesLabor: true,
    includesDisposal: true,
    includesStairs: false,
    advertisedPriceCents: 6500, // "starts at $65 for a single bulky item (Includes: labor, transportation & disposal)"
    minimumChargeCents: 6500,
    additionalItemCents: 1500,
    conditions: "Single bulky item, curbside; includes labor, transportation & disposal. +$15/additional item.",
    confidence: "MEDIUM",
    staleAfterDays: 30,
  },
  {
    marketCode: "INDY",
    zipCode: "46204",
    competitor: "Dropcurb",
    sourceUrl: "https://dropcurb.com/cost/bulk-junk-removal/indianapolis-in",
    observedAt: OBSERVED,
    serviceType: "CURBSIDE",
    pricingBasis: "ITEM",
    comparableTier: null,
    includesLabor: true,
    includesDisposal: true,
    includesStairs: false,
    advertisedPriceCents: 7900, // "single-item, curbside-only ... starts at $79" (first-item price covers truck, labor, disposal)
    additionalItemCents: 2500,
    conditions: "Single-item curbside, no in-home work; first-item price covers truck, labor and disposal.",
    confidence: "MEDIUM",
    staleAfterDays: 30,
  },

  // --- South Bend / Michiana (SOUTH-BEND) ----------------------------------
  {
    marketCode: "SOUTH-BEND",
    zipCode: "46514",
    competitor: "LoadUp",
    sourceUrl: "https://goloadup.com/junk-removal/in/elkhart/",
    observedAt: OBSERVED,
    serviceType: "CURBSIDE",
    pricingBasis: "ITEM",
    comparableTier: null,
    includesLabor: true,
    includesDisposal: true,
    includesStairs: false,
    advertisedPriceCents: 6500, // Elkhart "starts at $65 for a single bulky item (Includes: labor, transportation & disposal)"
    minimumChargeCents: 6500,
    additionalItemCents: 1500,
    conditions: "Elkhart single bulky item, curbside; includes labor, transportation & disposal.",
    confidence: "MEDIUM",
    staleAfterDays: 30,
  },
  {
    marketCode: "SOUTH-BEND",
    zipCode: "46530",
    competitor: "LoadUp",
    sourceUrl: "https://goloadup.com/granger/",
    observedAt: OBSERVED,
    serviceType: "CURBSIDE",
    pricingBasis: "ITEM",
    comparableTier: null,
    includesLabor: true,
    includesDisposal: true,
    includesStairs: false,
    advertisedPriceCents: 7900, // Granger "starts at $79 for a single bulky item (Includes: labor, transportation & disposal)"
    additionalItemCents: 1500,
    conditions: "Granger single bulky item, curbside; includes labor, transportation & disposal. +$15/additional item.",
    confidence: "MEDIUM",
    staleAfterDays: 30,
  },
];

// Per-URL independent verification record (correction handoff BLOCKER 6).
export const VERIFICATION_LOG = [
  {
    competitor: "LoadUp", market: "INDY", url: "https://goloadup.com/indianapolis/",
    httpResult: "200 OK (page reachable, FAQ read)", observedPriceUsd: 65, date: "2026-11-07",
    serviceEquivalence: "Economy / curbside single bulky item; labor + transport + disposal included",
    confidence: "MEDIUM", note: "Quote: 'LoadUp pricing for junk removal in Indianapolis starts at $65 for a single bulky item (Includes: labor, transportation & disposal costs).' Corrects earlier $79 draft.",
  },
  {
    competitor: "Dropcurb", market: "INDY", url: "https://dropcurb.com/cost/bulk-junk-removal/indianapolis-in",
    httpResult: "200 OK (2026 cost guide read)", observedPriceUsd: 79, date: "2026-11-07",
    serviceEquivalence: "Economy / single-item curbside, no in-home work",
    confidence: "MEDIUM", note: "Quote: 'single-item, curbside-only bulk junk removal job, which starts at $79 ... covers the truck, the labor, and disposal.'",
  },
  {
    competitor: "LoadUp", market: "SOUTH-BEND", url: "https://goloadup.com/junk-removal/in/elkhart/",
    httpResult: "200 OK (FAQ read)", observedPriceUsd: 65, date: "2026-11-07",
    serviceEquivalence: "Economy / curbside single bulky item; labor + transport + disposal included",
    confidence: "MEDIUM", note: "Quote: 'LoadUp pricing for junk removal in Elkhart starts at $65 for a single bulky item (Includes: labor, transportation & disposal costs).'",
  },
  {
    competitor: "LoadUp", market: "SOUTH-BEND", url: "https://goloadup.com/granger/",
    httpResult: "200 OK (FAQ read)", observedPriceUsd: 79, date: "2026-11-07",
    serviceEquivalence: "Economy / curbside single bulky item; labor + transport + disposal included",
    confidence: "MEDIUM", note: "Quote: 'LoadUp pricing for junk removal in Granger, Indiana starts at $79 for a single bulky item (Includes: labor, transportation & disposal costs). Each additional junk item starts at $15 per item.'",
  },
  {
    competitor: "(national full-service figures)", market: "both", url: "n/a",
    httpResult: "REMOVED", observedPriceUsd: null, date: "2026-11-07",
    serviceEquivalence: "n/a",
    confidence: "EXCLUDED", note: "Earlier draft's $400 half-truck / $650 full-truck figures were national averages, not verified local quotes. Removed per BLOCKER 6. Verified LOCAL full-service and transfer-station/disposal costs remain an owner blocker before any price approval.",
  },
] as const;
