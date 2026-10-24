import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { isBrokerageCapabilityEnabled } from "@/lib/compliance/service-separation";

/**
 * Freight load LIST for the operations console (read contract). Admin-gated,
 * NOT brokerage-gated: the console stays available to authorized admins for
 * config/test data even while brokerage is dormant. The response includes the
 * brokerage flag state so the UI can disable production actions.
 * Recruiters are NOT included in the allowed roles.
 */
const OPS_ROLES = ["ADMIN", "FINANCE_ADMIN", "SUPER_ADMIN"] as const;

export async function GET(request: Request) {
  try { await requireRole(request, OPS_ROLES as unknown as ("ADMIN")[]); }
  catch (e) { if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; }

  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const marketId = url.searchParams.get("marketId");
  const carrierId = url.searchParams.get("carrierId");
  const shipperUserId = url.searchParams.get("shipperUserId");
  const equipmentType = url.searchParams.get("equipmentType");

  const loads = await prisma.freightLoad.findMany({
    where: {
      ...(status ? { status: status as never } : {}),
      ...(marketId ? { marketId } : {}),
      ...(carrierId ? { assignedCarrierId: carrierId } : {}),
      ...(shipperUserId ? { shipperUserId } : {}),
      ...(equipmentType ? { equipmentType } : {}),
    },
    select: {
      id: true, status: true, marketId: true, shipperUserId: true, assignedCarrierId: true,
      commodity: true, equipmentType: true, weightLbs: true,
      customerTotalCents: true, carrierTotalCents: true, grossMarginCents: true, platformRevenueCents: true,
      createdAt: true, updatedAt: true,
      _count: { select: { offers: true, rateConfirmations: true, invoices: true, settlements: true } },
    },
    orderBy: { updatedAt: "desc" }, take: 500,
  });

  const brokerageActive = await isBrokerageCapabilityEnabled("loadPosting");
  return NextResponse.json({ loads, brokerageActive });
}
