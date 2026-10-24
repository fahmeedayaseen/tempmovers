import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";

/**
 * Shipper invoice history. Only invoices for the caller's own loads. Customer
 * charge fields only — the invoice already reflects the transportation price
 * with no carrier/margin breakdown.
 */
const SHIPPER_ROLES = ["CUSTOMER", "ADMIN", "SUPER_ADMIN"] as const;

export async function GET(request: Request) {
  let authed;
  try { authed = await requireRole(request, SHIPPER_ROLES as unknown as ("ADMIN")[]); }
  catch (e) { if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; }

  const invoices = await prisma.customerInvoice.findMany({
    where: { load: { shipperUserId: authed.userId } },
    select: { id: true, invoiceNumber: true, chargesCents: true, accessorialsCents: true, taxCents: true, totalCents: true, paymentTerms: true, dueDate: true, status: true, createdAt: true, loadId: true },
    orderBy: { createdAt: "desc" }, take: 300,
  });
  return NextResponse.json({ invoices });
}
