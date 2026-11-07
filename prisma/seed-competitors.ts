// Market Pricing Intelligence — competitor observation seed (Phase 1, 7 Nov 2026).
//
// Idempotent, additive, staging-only. Inserts the manually verified competitor
// observations from lib/junk/seed-competitors.ts. Safe to re-run: an observation
// with the same (marketCode, competitor, sourceUrl, observedAt) is skipped.
//
// It does NOT create or approve any price, and it does NOT touch PricingRule,
// PaymentPolicyConfig, jobs or payments. Observations are reference data only.
//
//   tsx prisma/seed-competitors.ts
import { PrismaClient } from "@prisma/client";
import { COMPETITOR_OBSERVATIONS } from "../lib/junk/seed-competitors";

const prisma = new PrismaClient();

async function main() {
  let created = 0;
  let skipped = 0;
  for (const o of COMPETITOR_OBSERVATIONS) {
    const existing = await prisma.competitorObservation.findFirst({
      where: { marketCode: o.marketCode, competitor: o.competitor, sourceUrl: o.sourceUrl, observedAt: o.observedAt },
      select: { id: true },
    });
    if (existing) {
      skipped++;
      continue;
    }
    await prisma.competitorObservation.create({
      data: {
        marketCode: o.marketCode,
        zipCode: o.zipCode,
        competitor: o.competitor,
        sourceUrl: o.sourceUrl,
        observedAt: o.observedAt,
        serviceType: o.serviceType,
        pricingBasis: o.pricingBasis,
        comparableTier: o.comparableTier ?? null,
        includesLabor: o.includesLabor,
        includesDisposal: o.includesDisposal,
        includesStairs: o.includesStairs ?? false,
        minimumChargeCents: o.minimumChargeCents ?? null,
        advertisedPriceCents: o.advertisedPriceCents,
        additionalItemCents: o.additionalItemCents ?? null,
        conditions: o.conditions ?? null,
        confidence: o.confidence,
        staleAfterDays: o.staleAfterDays,
        active: true,
      },
    });
    created++;
  }
  console.log(`Competitor observations seeded: ${created} created, ${skipped} already present.`);
  console.log("NOTE: recommendations are NOT generated or approved by this script. Prices remain owner-approved only.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
