import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

type Client = Prisma.TransactionClient | typeof prisma;

/**
 * Single source of truth for which loads are eligible to bill a partner
 * for a given period — shared by the billing preview
 * (GET /api/partners/[partnerId]/billing) and the invoice generation
 * route (POST /api/partners/[partnerId]/invoices), after a review found
 * they used genuinely different rules: the preview filtered by
 * `createdAt` with no payment/delivery/already-invoiced checks at all,
 * while generation correctly required CAPTURED + actually delivered +
 * not already on another invoice, filtered by `deliveredAt`. An admin
 * could preview one set of loads and totals, then generate an invoice
 * covering a completely different set.
 *
 * Mirrors the exact shared-helper approach used for
 * lib/capture-preview.ts: one function both callers depend on, so the
 * two structurally cannot drift apart again.
 */
export async function findEligiblePartnerLoads(client: Client, partnerId: string, periodStart: Date, periodEnd: Date) {
  return client.carrierRoute.findMany({
    where: {
      partnerOrganizationId: partnerId,
      paymentStatus: "CAPTURED",
      status: { in: ["DELIVERED", "POD_UPLOADED", "SETTLED"] },
      partnerInvoiceLine: null,
      deliveredAt: { gte: periodStart, lt: periodEnd },
    },
    select: { id: true, title: true, status: true, grossCarrierCents: true, platformFeeCents: true, deliveredAt: true },
  });
}
