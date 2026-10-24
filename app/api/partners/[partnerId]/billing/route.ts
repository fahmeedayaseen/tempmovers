import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { findEligiblePartnerLoads } from "@/lib/partner-invoice-eligibility";
import { resolvePartnerReadAccess } from "@/lib/partner-permissions";

/**
 * Read-only billing report — distinct from
 * POST /api/partners/[partnerId]/invoices, which actually generates and
 * bills a real PartnerInvoice. This just previews what a period would
 * total, without creating anything.
 *
 * P2-01 fix: previously took `from`/`to` as raw, unvalidated
 * `new Date(searchParams.get(...))` — an invalid or missing string
 * silently became `Invalid Date` and propagated into a broken query
 * rather than a clear error. No max range, no boundary convention, and
 * no pagination on line items (a long-lived partner could return an
 * unbounded response).
 */
const MAX_PERIOD_DAYS = 92;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

const schema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export async function GET(request: Request, context: { params: Promise<{ partnerId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["CUSTOMER", "ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { partnerId } = await context.params;

  const { searchParams } = new URL(request.url);
  const parsed = schema.safeParse({
    from: searchParams.get("from") ?? undefined,
    to: searchParams.get("to") ?? undefined,
    page: searchParams.get("page") ?? undefined,
    pageSize: searchParams.get("pageSize") ?? undefined,
  });
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  // Default to the current calendar month if not specified, expressed as
  // a UTC half-open range [from, to) — a load created exactly at `to`
  // belongs to the NEXT period, not this one.
  const now = new Date();
  const from = parsed.data.from ? new Date(parsed.data.from) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = parsed.data.to ? new Date(parsed.data.to) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  if (to <= from) {
    return NextResponse.json({ error: "`to` must be after `from`." }, { status: 400 });
  }
  const spanDays = (to.getTime() - from.getTime()) / 86_400_000;
  if (spanDays > MAX_PERIOD_DAYS) {
    return NextResponse.json({ error: `Reporting period cannot exceed ${MAX_PERIOD_DAYS} days.` }, { status: 400 });
  }

  const access = await resolvePartnerReadAccess(prisma, partnerId, authed);
  if (!access.allowed) return NextResponse.json({ error: access.reason }, { status: access.reason === "Partner not found." ? 404 : 403 });
  const partner = access.partner;
  if (!partner.monthlyInvoicing) {
    return NextResponse.json({ error: "This partner isn't on monthly invoicing." }, { status: 400 });
  }

  // Eligible = actually delivered AND actually paid — the same rule
  // POST /api/partners/[partnerId]/invoices uses to actually generate an
  // invoice, via lib/partner-invoice-eligibility.ts. Previously this
  // route filtered by createdAt with no payment/delivery/already-
  // invoiced checks at all — an admin could preview one set of loads
  // and totals, then generate an invoice covering a completely
  // different set. Paginated in memory over the shared result (not by
  // parametrizing the helper with skip/take) so the eligibility query
  // itself stays identical between both callers, with no separate
  // pagination plumbing that could introduce a second subtle
  // difference later.
  const eligibleLoads = await findEligiblePartnerLoads(prisma, partnerId, from, to);
  const totalCount = eligibleLoads.length;
  const startIndex = (parsed.data.page - 1) * parsed.data.pageSize;
  const loads = eligibleLoads.slice(startIndex, startIndex + parsed.data.pageSize);

  const subtotalCents = eligibleLoads.reduce((sum, l) => sum + l.grossCarrierCents, 0);
  const platformFeeCents = eligibleLoads.reduce((sum, l) => sum + l.platformFeeCents, 0);

  return NextResponse.json({
    partner: { id: partner.id, displayName: partner.displayName },
    period: { from, to },
    lineItems: loads,
    pagination: { page: parsed.data.page, pageSize: parsed.data.pageSize, totalCount, totalPages: Math.ceil(totalCount / parsed.data.pageSize) },
    subtotalCents, platformFeeCents, totalCents: subtotalCents + platformFeeCents,
  });
}
