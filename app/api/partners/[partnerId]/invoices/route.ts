import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { stripe } from "@/lib/stripe";
import { requireRole, AuthError } from "@/lib/auth";
import { captureIntegrationAlert } from "@/lib/monitoring";
import { findEligiblePartnerLoads } from "@/lib/partner-invoice-eligibility";
import { ensureStripeCustomer } from "@/lib/ensure-stripe-customer";
import { resolvePartnerReadAccess, resolvePartnerWriteAccess } from "@/lib/partner-permissions";

/**
 * Real partner invoicing — the previous /billing endpoint only summed
 * loads by createdAt with no eligibility rule and created nothing
 * durable. This generates an actual PartnerInvoice with frozen
 * PartnerInvoiceLine snapshots, then creates/finalizes/sends a real
 * Stripe Invoice against the partner's underlying CustomerProfile.
 *
 * Eligibility (P0-04's core fix): a load is billable once, only once
 * it's actually delivered AND captured — never by createdAt, which
 * would bill for loads that were never fulfilled or never paid. The
 * unique constraint on PartnerInvoiceLine.loadId is what prevents two
 * invoice-generation runs from double-billing the same load if their
 * periods overlap.
 */
const schema = z.object({
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime(),
});

const MAX_PERIOD_DAYS = 92; // roughly one quarter — a sanity cap, not a business rule

/**
 * Lists a partner's already-generated invoices — status, period,
 * totals, and Stripe invoice ID where available. Distinct from the
 * POST handler below, which creates a new one; this is read-only.
 */
export async function GET(request: Request, context: { params: Promise<{ partnerId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["CUSTOMER", "ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { partnerId } = await context.params;
  const access = await resolvePartnerReadAccess(prisma, partnerId, authed);
  if (!access.allowed) return NextResponse.json({ error: access.reason }, { status: access.reason === "Partner not found." ? 404 : 403 });

  const invoices = await prisma.partnerInvoice.findMany({
    where: { partnerOrganizationId: partnerId },
    select: {
      id: true, periodStart: true, periodEnd: true, status: true, subtotalCents: true, platformFeeCents: true, totalCents: true,
      stripeInvoiceId: true, dueDate: true, finalizedAt: true, paidAt: true, voidedAt: true, createdAt: true,
      lines: { select: { id: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  return NextResponse.json({
    invoices: invoices.map((inv) => ({ ...inv, lineCount: inv.lines.length, lines: undefined })),
  });
}

export async function POST(request: Request, context: { params: Promise<{ partnerId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["CUSTOMER", "ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { partnerId } = await context.params;

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  // UTC half-open range [start, end) — a load delivered exactly at
  // periodEnd belongs to the NEXT period, not this one.
  const periodStart = new Date(parsed.data.periodStart);
  const periodEnd = new Date(parsed.data.periodEnd);
  if (periodEnd <= periodStart) {
    return NextResponse.json({ error: "periodEnd must be after periodStart." }, { status: 400 });
  }
  const spanDays = (periodEnd.getTime() - periodStart.getTime()) / 86_400_000;
  if (spanDays > MAX_PERIOD_DAYS) {
    return NextResponse.json({ error: `Billing period cannot exceed ${MAX_PERIOD_DAYS} days.` }, { status: 400 });
  }

  const access = await resolvePartnerWriteAccess(prisma, partnerId, authed);
  if (!access.allowed) return NextResponse.json({ error: access.reason }, { status: access.reason === "Partner not found." ? 404 : 403 });
  const partner = access.partner;
  if (!partner.monthlyInvoicing) {
    return NextResponse.json({ error: "This partner isn't on monthly invoicing." }, { status: 400 });
  }

  // Eligible = actually delivered AND actually paid — never by createdAt.
  // Shared with the billing preview route (GET .../billing) via
  // lib/partner-invoice-eligibility.ts, after a review found the two
  // routes used genuinely different rules — an admin could preview one
  // set of loads and generate an invoice covering a different one.
  const billableLoads = await findEligiblePartnerLoads(prisma, partnerId, periodStart, periodEnd);

  if (billableLoads.length === 0) {
    return NextResponse.json({ error: "No billable loads found for this period." }, { status: 409 });
  }

  const subtotalCents = billableLoads.reduce((sum, l) => sum + l.grossCarrierCents, 0);
  const platformFeeCents = billableLoads.reduce((sum, l) => sum + l.platformFeeCents, 0);
  const totalCents = subtotalCents + platformFeeCents;

  // Create the invoice and frozen line snapshots in one transaction —
  // either every load gets locked to this invoice or none do, so a
  // partial failure can't leave some loads billed and others silently
  // skipped.
  // Ensures the partner's underlying CustomerProfile has a real Stripe
  // customer — found during the same end-to-end review that surfaced
  // the identical gap in job/load payment and detention charging.
  // Without this, every partner invoice would have silently fallen back
  // to the DRAFT-only path below, since nothing anywhere ever created a
  // Stripe customer for a CustomerProfile before this fix.
  const stripeCustomerId = await ensureStripeCustomer(prisma, partner.customer.id);

  const invoice = await prisma.$transaction(async (tx) => {
    const created = await tx.partnerInvoice.create({
      data: {
        partnerOrganizationId: partnerId, periodStart, periodEnd,
        status: "DRAFT", subtotalCents, platformFeeCents, totalCents,
        stripeCustomerId,
      },
    });
    await tx.partnerInvoiceLine.createMany({
      data: billableLoads.map((l) => ({
        partnerInvoiceId: created.id, loadId: l.id, title: l.title,
        deliveredAt: l.deliveredAt, grossCarrierCents: l.grossCarrierCents,
        platformFeeCents: l.platformFeeCents, lineTotalCents: l.grossCarrierCents + l.platformFeeCents,
      })),
    });
    await tx.auditLog.create({
      data: { actorId: authed.userId, action: "PARTNER_INVOICE_CREATED", entityType: "PartnerInvoice", entityId: created.id, details: { partnerId, periodStart, periodEnd, totalCents, loadCount: billableLoads.length } },
    });
    return created;
  });

  try {
    for (const line of billableLoads) {
      await stripe.invoiceItems.create({
        customer: stripeCustomerId,
        amount: line.grossCarrierCents + line.platformFeeCents,
        currency: "usd",
        description: `${line.title} — delivered ${line.deliveredAt?.toISOString().slice(0, 10) ?? "n/a"}`,
      });
    }

    const stripeInvoice = await stripe.invoices.create({
      customer: stripeCustomerId,
      collection_method: "send_invoice",
      days_until_due: 30,
      auto_advance: false,
      metadata: { partnerInvoiceId: invoice.id, partnerId },
    });

    const finalized = await stripe.invoices.finalizeInvoice(stripeInvoice.id!);
    const sent = await stripe.invoices.sendInvoice(finalized.id!);

    const updated = await prisma.partnerInvoice.update({
      where: { id: invoice.id },
      data: {
        status: "SENT", stripeInvoiceId: sent.id,
        finalizedAt: new Date(),
        dueDate: sent.due_date ? new Date(sent.due_date * 1000) : null,
      },
    });

    return NextResponse.json({ invoice: updated });
  } catch (error) {
    captureIntegrationAlert("Partner invoice created in our database but Stripe invoice creation/finalization failed.", {
      area: "billing", partnerId, invoiceId: invoice.id, error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ invoice, error: "Invoice recorded but Stripe invoice creation failed. It remains in DRAFT for manual follow-up." }, { status: 502 });
  }
}
