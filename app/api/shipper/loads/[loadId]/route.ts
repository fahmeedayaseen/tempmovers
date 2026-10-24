import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { SHIPPER_LOAD_SELECT, toShipperStatus, carrierVisibleToShipper } from "@/lib/shipper/view";

/**
 * Shipper load detail. Ownership-scoped. Returns ONLY shipper-safe data:
 * customer price, stops, business status, shipper-entitled documents, and
 * customer-billable accessorials. Explicitly EXCLUDES carrier rate, margin,
 * platform revenue, carrier offers, eligibility blockers, factoring, payment
 * routing, internal notes, and audit events — none are selected here.
 */
const SHIPPER_ROLES = ["CUSTOMER", "ADMIN", "SUPER_ADMIN"] as const;


export async function GET(request: Request, { params }: { params: { loadId: string } }) {
  let authed;
  try { authed = await requireRole(request, SHIPPER_ROLES as unknown as ("ADMIN")[]); }
  catch (e) { if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; }

  const load = await prisma.freightLoad.findUnique({
    where: { id: params.loadId },
    select: {
      ...SHIPPER_LOAD_SELECT,
      shipperUserId: true,
      assignedCarrierId: true,
      proofOfDeliveryUrl: true,
      stops: { orderBy: { sequence: "asc" }, select: { sequence: true, stopType: true, city: true, state: true, zip: true, appointmentAt: true } },
      // Customer-billable accessorials only; approved customer amount only.
      accessorials: { where: { customerBillable: true }, select: { id: true, kind: true, approvedAmountCents: true, approvalStatus: true } },
      invoices: { select: { id: true, invoiceNumber: true, totalCents: true, status: true, dueDate: true } },
    },
  });
  if (!load) return NextResponse.json({ error: "Load not found." }, { status: 404 });
  if (load.shipperUserId !== authed.userId && !["ADMIN", "SUPER_ADMIN"].includes(authed.role)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  // Carrier identity only when the stage allows; and only the business name, no
  // carrier financial/compliance data.
  let carrier = null;
  if (load.assignedCarrierId && carrierVisibleToShipper(load.status)) {
    carrier = await prisma.carrier.findUnique({ where: { id: load.assignedCarrierId }, select: { legalBusinessName: true } });
  }

  // POD visibility: whether a POD is on file (approved once load is COMPLETED).
  // We expose availability, not a raw storage URL (private-storage pattern).
  const podAvailable = !!load.proofOfDeliveryUrl;

  const { status, assignedCarrierId, shipperUserId, proofOfDeliveryUrl, ...safe } = load;
  return NextResponse.json({
    load: { ...safe, shipperStatus: toShipperStatus(status) },
    carrierName: carrier?.legalBusinessName ?? null,
    podAvailable,
  });
}
