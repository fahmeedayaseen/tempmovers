import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { evaluateFunding } from "@/lib/payments/funding";

/**
 * Funding ledger for one job or load — VASRUE Digital Media, 29 Oct 2026.
 *
 * GET /api/admin/funding?type=JOB|LOAD|FREIGHT_LOAD&id=... (admin). The gate's
 * verdict, re-read from Stripe, with every record behind it: quote versions,
 * funding attempts, change orders, settlement and allocations, disposal,
 * refunds, and audited exceptions (payment spec §8 ledger retrieval).
 */
export async function GET(request: Request) {
  try {
    await requireRole(request, ["ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const url = new URL(request.url);
  const type = url.searchParams.get("type");
  const id = url.searchParams.get("id");
  if (!id || (type !== "JOB" && type !== "LOAD" && type !== "FREIGHT_LOAD")) {
    return NextResponse.json({ error: "Pass type=JOB|LOAD|FREIGHT_LOAD and id." }, { status: 400 });
  }

  const ref = { type, id } as const;
  const [funding, quotes, attempts, changeOrders, settlement, allocations, disposal, exceptions, refunds] = await Promise.all([
    evaluateFunding(ref, { refresh: true }),
    prisma.quoteVersion.findMany({ where: { entityType: type, entityId: id }, orderBy: { version: "asc" } }),
    prisma.fundingAttempt.findMany({ where: { entityType: type, entityId: id }, orderBy: { createdAt: "asc" } }),
    prisma.changeOrder.findMany({ where: { entityType: type, entityId: id }, orderBy: { version: "asc" } }),
    prisma.paymentSettlement.findUnique({ where: { entityType_entityId: { entityType: type, entityId: id } } }),
    prisma.paymentAllocation.findMany({ where: { entityType: type, entityId: id }, orderBy: { createdAt: "asc" } }),
    type === "JOB" ? prisma.disposalExpense.findUnique({ where: { jobId: id } }) : Promise.resolve(null),
    prisma.paymentException.findMany({ where: { entityType: type, entityId: id }, orderBy: { createdAt: "asc" } }),
    type === "FREIGHT_LOAD" ? Promise.resolve([]) : prisma.paymentRefund.findMany({ where: { paymentTransaction: type === "JOB" ? { jobId: id } : { loadId: id } }, orderBy: { createdAt: "asc" } }),
  ]);

  const allocatedCents = allocations.reduce((a, r) => a + r.amountCents, 0);
  return NextResponse.json({
    funding, quotes, attempts, changeOrders, settlement, allocations, disposal, exceptions, refunds,
    ledgerCheck: settlement ? { collectedCents: settlement.collectedCents, allocatedCents, balanced: allocatedCents === settlement.collectedCents } : null,
  });
}
