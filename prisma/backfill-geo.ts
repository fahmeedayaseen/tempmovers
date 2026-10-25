
// BLOCK-05 — VASRUE Digital Media, 24 Oct 2026.
// MarketStage was renamed; CONTROLLED_LAUNCH no longer exists. The value used
// here is not a guess: prisma/manual/market_stage_reconcile.sql, written by
// the client, documents the intended mapping as CONTROLLED_LAUNCH -> SOFT_LAUNCH.
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

/**
 * One-time backfill for the geographic hierarchy. Run AFTER `prisma migrate
 * dev` has added the new nullable Market/Territory columns, and BEFORE
 * enforcing them as non-null (that enforcement is a deliberate later step,
 * not part of this script — see step 8 below).
 *
 * Order matters: markets and territories must exist before anything can
 * reference them.
 */
async function main() {
  // 1. Create/upsert the Indianapolis market — same marketCode ("INDY") as
  // prisma/seed.ts uses, so running seed then backfill enriches the same
  // row instead of creating a second, duplicate Indianapolis market.
  const indianapolis = await prisma.launchMarket.upsert({
    where: { marketCode: "INDY" },
    update: {
      countryCode: "US", timezone: "America/Indiana/Indianapolis", stage: "SOFT_LAUNCH",
      publicBookingEnabled: true, workerRecruitingEnabled: true, freightEnabled: true,
      centerLat: 39.7684, centerLng: -86.1581, defaultRadiusMiles: 30,
    },
    create: {
      marketCode: "INDY",
      name: "Indianapolis",
      state: "IN",
      countryCode: "US",
      timezone: "America/Indiana/Indianapolis",
      stage: "SOFT_LAUNCH",
      publicBookingEnabled: true,
      workerRecruitingEnabled: true,
      freightEnabled: true,
      centerLat: 39.7684,
      centerLng: -86.1581,
      defaultRadiusMiles: 30,
    },
  });

  // 2. Create initial Indianapolis territories.
  const territoryDefs = [
    { slug: "downtown-indy", name: "Downtown Indianapolis", city: "Indianapolis", zipCodes: ["46204", "46202", "46225"] },
    { slug: "north-indy", name: "North Indianapolis / Carmel", city: "Carmel", zipCodes: ["46220", "46240", "46032", "46033"] },
  ];
  const territories = [];
  for (const t of territoryDefs) {
    territories.push(
      await prisma.territory.upsert({
        where: { marketId_slug: { marketId: indianapolis.id, slug: t.slug } },
        update: {},
        create: {
          marketId: indianapolis.id, slug: t.slug, name: t.name, type: "METRO", status: "ACTIVE",
          city: t.city, state: "IN", zipCodes: t.zipCodes,
        },
      }),
    );
  }

  // 3. Backfill existing jobs with marketId = Indianapolis. Territory
  // inference from public area/ZIP/geocoded coordinates needs a real
  // geocoder (not yet wired — see README "Production work still
  // required") so territoryId is left null here for a human/admin to
  // assign, rather than guessing.
  const jobBackfill = await prisma.job.updateMany({
    where: { marketId: null },
    data: { marketId: indianapolis.id },
  });

  // 4. Backfill CarrierRoute origin/destination market IDs by state match.
  const originBackfill = await prisma.carrierRoute.updateMany({
    where: { originMarketId: null, originState: "IN" },
    data: { originMarketId: indianapolis.id },
  });
  const destBackfill = await prisma.carrierRoute.updateMany({
    where: { destinationMarketId: null, destinationState: "IN" },
    data: { destinationMarketId: indianapolis.id },
  });

  // 5. Backfill WorkerMarket for all current Indianapolis workers/drivers.
  // Radius/home-lat-lng backfill needs geocoded home ZIPs — left null here
  // for the same reason as territory inference above.
  const workers = await prisma.workerProfile.findMany({ select: { id: true } });
  let workerMarketCount = 0;
  for (const w of workers) {
    await prisma.workerMarket.upsert({
      where: { workerId_marketId: { workerId: w.id, marketId: indianapolis.id } },
      update: {},
      create: { workerId: w.id, marketId: indianapolis.id, active: true, acceptingJobs: true },
    });
    workerMarketCount += 1;
  }

  // 6. Backfill PartnerMarket for existing partners.
  const partners = await prisma.partnerOrganization.findMany({ select: { id: true } });
  let partnerMarketCount = 0;
  for (const p of partners) {
    await prisma.partnerMarket.upsert({
      where: { partnerId_marketId: { partnerId: p.id, marketId: indianapolis.id } },
      update: {},
      create: { partnerId: p.id, marketId: indianapolis.id, active: true },
    });
    partnerMarketCount += 1;
  }

  // 9. Audit trail for this automated backfill run, plus an exception
  // report for anything that couldn't be confidently assigned (currently:
  // any CarrierRoute whose origin/destination state isn't IN — those need
  // a human to pick the right market since this script only handles the
  // single-market Indianapolis case).
  const unassignedRoutes = await prisma.carrierRoute.findMany({
    where: { OR: [{ originMarketId: null }, { AND: [{ destinationMarketId: null }, { destinationCity: { not: "" } }] }] },
    select: { id: true, title: true, originCity: true, originState: true, destinationCity: true, destinationState: true },
  });

  await prisma.auditLog.create({
    data: {
      action: "GEO_BACKFILL_RUN",
      entityType: "LaunchMarket",
      entityId: indianapolis.id,
      details: {
        jobsBackfilled: jobBackfill.count,
        originRoutesBackfilled: originBackfill.count,
        destinationRoutesBackfilled: destBackfill.count,
        workerMarketsCreated: workerMarketCount,
        partnerMarketsCreated: partnerMarketCount,
        territoriesCreated: territories.length,
        unassignedRouteCount: unassignedRoutes.length,
      },
    },
  });

  console.log(`Backfill complete: ${jobBackfill.count} jobs, ${originBackfill.count + destBackfill.count} route legs, ${workerMarketCount} worker markets, ${partnerMarketCount} partner markets.`);
  if (unassignedRoutes.length > 0) {
    console.log(`EXCEPTION REPORT — ${unassignedRoutes.length} route(s) need manual market assignment (non-Indiana origin/destination):`);
    for (const r of unassignedRoutes) {
      console.log(`  - ${r.id} "${r.title}": ${r.originCity}, ${r.originState} -> ${r.destinationCity}, ${r.destinationState}`);
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
