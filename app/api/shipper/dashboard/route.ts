import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { toShipperStatus } from "@/lib/shipper/view";

/**
 * Shipper dashboard. Counts across the caller's own loads only, grouped into
 * shipper-friendly statuses. No financial internals.
 */
const SHIPPER_ROLES = ["CUSTOMER", "ADMIN", "SUPER_ADMIN"] as const;

export async function GET(request: Request) {
  let authed;
  try { authed = await requireRole(request, SHIPPER_ROLES as unknown as ("ADMIN")[]); }
  catch (e) { if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; }

  // BLOCK-13 — VASRUE Digital Media, 27 October 2026.
  //
  // This filter excluded "CANCELED", which is not a CustomerInvoiceStatus. The
  // enum's closed states are PAID, VOID and WRITTEN_OFF. Postgres rejects an
  // unknown enum value for the whole query, so every request to this endpoint
  // returned 500 — found by the first smoke test of the deployed app against a
  // real database. An `as never` cast had silenced the type checker; with it
  // removed, an invalid status here is a compile error instead of a runtime one.
  const [byStatus, openInvoices] = await Promise.all([
    prisma.freightLoad.groupBy({ by: ["status"], where: { shipperUserId: authed.userId }, _count: { _all: true } }),
    prisma.customerInvoice.count({ where: { load: { shipperUserId: authed.userId }, status: { notIn: ["PAID", "VOID", "WRITTEN_OFF"] } } }),
  ]);

  // Collapse internal statuses into shipper-friendly buckets.
  const buckets: Record<string, number> = {};
  for (const row of byStatus) {
    const key = toShipperStatus(row.status);
    buckets[key] = (buckets[key] ?? 0) + row._count._all;
  }

  const active = (buckets.BOOKED ?? 0) + (buckets.SCHEDULED ?? 0) + (buckets.IN_TRANSIT ?? 0);
  const delivered = (buckets.DELIVERED ?? 0) + (buckets.COMPLETED ?? 0);

  return NextResponse.json({ buckets, activeLoads: active, deliveredLoads: delivered, openInvoices });
}
