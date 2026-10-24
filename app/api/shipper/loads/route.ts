import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { SHIPPER_LOAD_SELECT, toShipperStatus } from "@/lib/shipper/view";

/**
 * Shipper loads list. Scoped to the caller's own loads (shipperUserId). Uses the
 * shipper-safe select — customer price only, never carrier pay or margin. Status
 * is mapped to a business-friendly value. Supports a coarse group filter.
 */
const SHIPPER_ROLES = ["CUSTOMER", "ADMIN", "SUPER_ADMIN"] as const;

export async function GET(request: Request) {
  let authed;
  try { authed = await requireRole(request, SHIPPER_ROLES as unknown as ("ADMIN")[]); }
  catch (e) { if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; }

  const loads = await prisma.freightLoad.findMany({
    where: { shipperUserId: authed.userId },
    select: SHIPPER_LOAD_SELECT,
    orderBy: { updatedAt: "desc" }, take: 300,
  });

  const rows = loads.map((l) => ({ ...l, shipperStatus: toShipperStatus(l.status), status: undefined }));
  return NextResponse.json({ loads: rows });
}
