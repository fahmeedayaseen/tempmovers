import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { isBrokerageCapabilityEnabled } from "@/lib/compliance/service-separation";

/**
 * Freight operations dashboard (read contract). Real DB counts by status and by
 * attention-need, plus cents-derived margin summaries. Admin-gated. Every count
 * has a real source; anything without a source is returned as null so the UI
 * shows "Not tracked" rather than a fabricated zero.
 */
const OPS_ROLES = ["ADMIN", "FINANCE_ADMIN", "SUPER_ADMIN"] as const;

export async function GET(request: Request) {
  try { await requireRole(request, OPS_ROLES as unknown as ("ADMIN")[]); }
  catch (e) { if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; }

  const [byStatus, offersPending, podPending, accessorialsPending, exceptions, marginAgg] = await Promise.all([
    prisma.freightLoad.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.carrierOffer.count({ where: { status: { in: ["PENDING", "VIEWED"] } } }),
    prisma.freightLoad.count({ where: { status: "POD_PENDING" } }),
    prisma.loadAccessorial.count({ where: { approvalStatus: "REQUESTED" } }),
    prisma.freightLoad.count({ where: { status: "EXCEPTION" } }),
    prisma.freightLoad.aggregate({ _sum: { grossMarginCents: true, platformRevenueCents: true, customerTotalCents: true } }),
  ]);

  const statusCounts: Record<string, number> = {};
  for (const row of byStatus) statusCounts[row.status] = row._count._all;

  // Loads awaiting a rate confirmation: assigned/accepted but none generated.
  const acceptedNoRateCon = await prisma.freightLoad.count({
    where: { status: { in: ["ACCEPTED", "DISPATCHED"] }, rateConfirmations: { none: {} } },
  });

  const brokerageActive = await isBrokerageCapabilityEnabled("loadPosting");

  return NextResponse.json({
    brokerageActive,
    statusCounts,
    attention: {
      offersAwaitingResponse: offersPending,
      loadsMissingRateConfirmation: acceptedNoRateCon,
      podsAwaitingApproval: podPending,
      accessorialsAwaitingReview: accessorialsPending,
      loadsInException: exceptions,
    },
    financials: {
      grossMarginCents: marginAgg._sum.grossMarginCents ?? 0,
      platformRevenueCents: marginAgg._sum.platformRevenueCents ?? 0,
      customerTotalCents: marginAgg._sum.customerTotalCents ?? 0,
    },
  });
}
