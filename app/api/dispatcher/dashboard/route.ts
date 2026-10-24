import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireDispatcher, listAccessibleCarrierIds, AuthError } from "@/lib/dispatcher/access";

/**
 * Dispatcher dashboard — aggregates ONLY across carriers the dispatcher has
 * active access to. Today's pickups/deliveries, loads needing attention,
 * active/in-transit, missing POD, and document/insurance warnings. No finance
 * or compliance data.
 */
export async function GET(request: Request) {
  let authed;
  try { authed = await requireDispatcher(request); }
  catch (e) { if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; }

  const carrierIds = await listAccessibleCarrierIds(authed.userId);
  if (carrierIds.length === 0) return NextResponse.json({ carriers: 0, activeInTransit: 0, missingPod: 0, todaysStops: 0, insuranceWarnings: 0, statusCounts: {} });

  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(); endOfDay.setHours(23, 59, 59, 999);

  const [byStatus, activeInTransit, missingPod, todaysStops, insuranceSoon] = await Promise.all([
    prisma.freightLoad.groupBy({ by: ["status"], where: { assignedCarrierId: { in: carrierIds } }, _count: { _all: true } }),
    prisma.freightLoad.count({ where: { assignedCarrierId: { in: carrierIds }, status: { in: ["DISPATCHED", "AT_PICKUP", "LOADED", "IN_TRANSIT", "AT_DELIVERY"] } } }),
    prisma.freightLoad.count({ where: { assignedCarrierId: { in: carrierIds }, status: "POD_PENDING" } }),
    prisma.freightStop.count({ where: { load: { assignedCarrierId: { in: carrierIds } }, appointmentAt: { gte: startOfDay, lte: endOfDay } } }),
    prisma.carrierInsurancePolicy.count({ where: { carrierId: { in: carrierIds }, expiresAt: { lte: new Date(Date.now() + 30 * 86400000) } } }),
  ]);

  const statusCounts: Record<string, number> = {};
  for (const row of byStatus) statusCounts[row.status] = row._count._all;

  return NextResponse.json({
    carriers: carrierIds.length,
    activeInTransit, missingPod, todaysStops, insuranceWarnings: insuranceSoon, statusCounts,
  });
}
