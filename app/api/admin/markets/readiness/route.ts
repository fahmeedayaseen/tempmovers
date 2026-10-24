import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { assembleReadinessDashboard, type ReadinessCounts } from "@/lib/markets/readiness-dashboard";

/**
 * Launch Readiness Dashboard (launch spec §6). Admin-only. Returns supply /
 * demand / platform / performance metrics for a market from REAL DB queries.
 *
 * Honesty rule: metrics the platform does not yet track (e.g. Stripe success
 * rate, which needs payment-event aggregation, or waitlist count, which needs
 * a waitlist table) are returned null and the UI shows "Not tracked" — never a
 * fabricated number. As those data sources are built, swap the null for the
 * real query; the shape is stable.
 */
const ADMIN_ROLES = ["ADMIN", "SUPPORT", "FINANCE_ADMIN", "SUPER_ADMIN"] as const;

export async function GET(request: Request) {
  try {
    await requireRole(request, ADMIN_ROLES as unknown as ("ADMIN")[]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const url = new URL(request.url);
  const marketId = url.searchParams.get("marketId");
  if (!marketId) return NextResponse.json({ error: "marketId is required." }, { status: 400 });

  const market = await prisma.launchMarket.findUnique({ where: { id: marketId } });
  if (!market) return NextResponse.json({ error: "Market not found." }, { status: 404 });

  // Real counts from confirmed fields. Worker supply by type in this market.
  const [movers, boxDrivers, semiDrivers, completedJobs] = await Promise.all([
    prisma.workerProfile.count({ where: { primaryMarketId: marketId, workerType: "MOVER" } }),
    prisma.workerProfile.count({ where: { primaryMarketId: marketId, workerType: "BOX_TRUCK_DRIVER" } }),
    prisma.workerProfile.count({ where: { primaryMarketId: marketId, workerType: "SEMI_DRIVER" } }),
    prisma.job.count({ where: { marketId, status: "COMPLETED" } }),
  ]).catch(() => [null, null, null, null] as (number | null)[]);

  // Real carrier counts (wired now that the Carrier entity exists).
  const now = new Date();
  const [approvedCarriers, activeCarriers, carriersWithInsurance, carrierApplications, docsPending, underReview, suspendedCarriers, expiredDocCarriers, fmcsaVerified, factoredCarriers, pendingNoa] = await Promise.all([
    prisma.carrier.count({ where: { marketId, status: { in: ["APPROVED", "ACTIVE"] } } }),
    prisma.carrier.count({ where: { marketId, status: "ACTIVE" } }),
    prisma.carrier.count({ where: { marketId, status: "ACTIVE", insurancePolicies: { some: { type: "AUTO_LIABILITY", expiresAt: { gt: now } } } } }),
    prisma.carrier.count({ where: { marketId, status: "APPLICATION_STARTED" } }),
    prisma.carrier.count({ where: { marketId, status: "DOCUMENTS_PENDING" } }),
    prisma.carrier.count({ where: { marketId, status: "UNDER_REVIEW" } }),
    prisma.carrier.count({ where: { marketId, status: "SUSPENDED" } }),
    prisma.carrier.count({ where: { marketId, status: "EXPIRED_DOCUMENTS" } }),
    prisma.carrier.count({ where: { marketId, fmcsaChecks: { some: { authorized: true } } } }),
    prisma.carrier.count({ where: { marketId, factoringProfile: { usesFactoring: true } } }),
    prisma.carrierFactoringProfile.count({ where: { verificationStatus: "PENDING_REVIEW", carrier: { marketId } } }),
  ]).catch(() => Array(11).fill(null) as (number | null)[]);

  const counts: ReadinessCounts = {
    // supply — from real worker counts; "approved" vs "active" distinction and
    // insurance-current count need a dedicated Carrier entity (next phase), so
    // those stay null until then rather than being faked.
    approvedMovers: movers,
    activeMovers: market.activeMovers ?? movers,
    approvedDrivers: boxDrivers != null && semiDrivers != null ? boxDrivers + semiDrivers : null,
    activeDrivers: market.activeBoxTruckDrivers + market.activeSemiDrivers,
    approvedCarriers: approvedCarriers,     // wired: Carrier entity now exists
    carriersWithCurrentInsurance: carriersWithInsurance,
    // demand — the ones without a data source yet are null, not zero-faked.
    registeredCustomers: null,              // needs market-scoped customer attribution
    recurringCustomers: null,
    signedPropertyPartners: market.signedPilotPartners ?? null,
    signedShippers: null,
    openBookingRequests: completedJobs != null ? await prisma.job.count({ where: { marketId, status: "POSTED" } }).catch(() => null) : null,
    waitlistCount: null,                    // needs a waitlist table
    // platform — payment success rate / defects / deploy metadata need their
    // own sources; null until wired.
    stripePaymentSuccessRate: null,
    failedPaymentCount: null,
    openProductionDefects: null,
    documentVerificationBacklog: null,
    migrationStatus: null,
    lastSuccessfulDeployment: null,
    lastEndToEndTestDate: null,
    // performance
    jobsCompleted: completedJobs,
    cancellationRate: null,
    averageRating: null,
    grossBookingValueCents: null,
    platformRevenueCents: null,
    workerPayoutCents: null,
  };

  return NextResponse.json({
    marketId,
    marketName: market.name,
    stage: market.stage,
    dashboard: assembleReadinessDashboard(counts),
    carriers: {
      applications: carrierApplications,
      documentsPending: docsPending,
      underReview,
      approved: approvedCarriers,
      active: activeCarriers,
      suspended: suspendedCarriers,
      expiredDocuments: expiredDocCarriers,
      withCurrentInsurance: carriersWithInsurance,
      fmcsaVerified,
      factored: factoredCarriers,
      pendingNoaReviews: pendingNoa,
    },
    note: "Metrics shown as null are not yet tracked and render as 'Not tracked'. They are wired as their data sources are built (e.g. approved carriers arrive with the Carrier Onboarding phase).",
  });
}
