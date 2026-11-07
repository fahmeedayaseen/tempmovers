import type { CompetitorObservationInput } from "@/lib/junk/market-intelligence";

// ---------------------------------------------------------------------------
// Verified competitor observations — Phase 1 seed (7 November 2026)
//
// MANUALLY collected and verified (directive §3, owner authorization §2). No
// scraping; scheduled collection is Phase 2. Each row carries its source URL
// and observation date so freshness and provenance are auditable.
//
// HONEST CONFIDENCE (important): only prices published on a competitor's own
// LOCAL page for a specific nearby city are recorded as MEDIUM confidence and
// used for benchmarking. National averages and cross-market comparison-blog
// figures are recorded as LOW confidence and are EXCLUDED from automatic
// benchmarking — they are kept only as context, never treated as verified local
// quotes. This is why, in this seed, the only benchmarkable data points are
// LoadUp's local curbside single-item prices; every full-service truckload
// figure below is national and LOW. Verified LOCAL full-service and disposal
// costs remain an outstanding owner blocker (directive §7).
// ---------------------------------------------------------------------------

export type SeededCompetitorObservation = CompetitorObservationInput & {
  marketCode: string;
  zipCode?: string;
  sourceUrl: string;
  conditions?: string;
};

// Observation date for this collection pass (local LoadUp pages read 2026-11-06).
const OBSERVED = new Date("2026-11-06T00:00:00.000Z");

export const COMPETITOR_OBSERVATIONS: SeededCompetitorObservation[] = [
  // --- Indianapolis Metro ---------------------------------------------------
  {
    marketCode: "INDY",
    zipCode: "46204",
    competitor: "LoadUp",
    sourceUrl: "https://goloadup.com/indianapolis-in/",
    observedAt: OBSERVED,
    serviceType: "CURBSIDE",
    pricingBasis: "ITEM",
    comparableTier: null,
    includesLabor: true,
    includesDisposal: true,
    includesStairs: false,
    advertisedPriceCents: 7900, // single bulky item, curbside
    minimumChargeCents: 9000,
    additionalItemCents: 1500,
    conditions: "Single bulky item, curbside; includes labor, transportation & disposal. +$15/additional item.",
    confidence: "MEDIUM", // local page, item-level
    staleAfterDays: 30,
  },
  {
    marketCode: "INDY",
    competitor: "1-800-GOT-JUNK",
    sourceUrl: "https://www.dropcurb.com/blog/how-much-does-it-cost-for-junk-removal",
    observedAt: OBSERVED,
    serviceType: "FULL_SERVICE",
    pricingBasis: "VOLUME",
    comparableTier: "HALF",
    includesLabor: true,
    includesDisposal: true,
    advertisedPriceCents: 40000, // ~national half-truck average
    conditions: "National average half-truck; NOT a verified local quote.",
    confidence: "LOW", // national estimate — excluded from benchmarking
    staleAfterDays: 30,
  },
  {
    marketCode: "INDY",
    competitor: "College HUNKS",
    sourceUrl: "https://goloadup.com/?p=3762114",
    observedAt: OBSERVED,
    serviceType: "FULL_SERVICE",
    pricingBasis: "VOLUME",
    comparableTier: "FULL",
    includesLabor: true,
    includesDisposal: true,
    advertisedPriceCents: 65000, // ~national full-truck average
    conditions: "National comparison figure; NOT a verified local quote.",
    confidence: "LOW",
    staleAfterDays: 30,
  },

  // --- South Bend / Michiana ------------------------------------------------
  {
    marketCode: "SOUTH-BEND",
    zipCode: "46514",
    competitor: "LoadUp",
    sourceUrl: "https://goloadup.com/elkhart-in/",
    observedAt: OBSERVED,
    serviceType: "CURBSIDE",
    pricingBasis: "ITEM",
    comparableTier: null,
    includesLabor: true,
    includesDisposal: true,
    includesStairs: false,
    advertisedPriceCents: 6500, // Elkhart single bulky item
    minimumChargeCents: 9000,
    additionalItemCents: 1500,
    conditions: "Elkhart single bulky item, curbside; includes labor, transportation & disposal.",
    confidence: "MEDIUM",
    staleAfterDays: 30,
  },
  {
    marketCode: "SOUTH-BEND",
    zipCode: "46530",
    competitor: "LoadUp",
    sourceUrl: "https://goloadup.com/granger-in/",
    observedAt: OBSERVED,
    serviceType: "CURBSIDE",
    pricingBasis: "ITEM",
    comparableTier: null,
    includesLabor: true,
    includesDisposal: true,
    includesStairs: false,
    advertisedPriceCents: 7900, // Granger single bulky item
    minimumChargeCents: 9000,
    additionalItemCents: 1500,
    conditions: "Granger single bulky item, curbside; includes labor, transportation & disposal.",
    confidence: "MEDIUM",
    staleAfterDays: 30,
  },
  {
    marketCode: "SOUTH-BEND",
    competitor: "Junk King",
    sourceUrl: "https://goloadup.com/?p=3761970",
    observedAt: OBSERVED,
    serviceType: "FULL_SERVICE",
    pricingBasis: "VOLUME",
    comparableTier: "HALF",
    includesLabor: true,
    includesDisposal: true,
    advertisedPriceCents: 40000, // ~national half-truck average
    conditions: "National comparison figure; NOT a verified local quote.",
    confidence: "LOW",
    staleAfterDays: 30,
  },
];
