import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { assertFreightAllowed, FreightGateError } from "@/lib/freight/gate";

/**
 * Customer invoice creation (P0-05). Idempotent via creationKey; invoiceNumber
 * is unique (duplicate-invoice prevention, criterion #9). Totals in integer
 * cents. Audited.
 */
const ADMIN_ROLES = ["ADMIN", "FINANCE_ADMIN", "SUPER_ADMIN"] as const;

const schema = z.object({
  loadId: z.string().min(1),
  invoiceNumber: z.string().min(1).max(60),
  chargesCents: z.number().int().nonnegative(),
  accessorialsCents: z.number().int().nonnegative().default(0),
  taxCents: z.number().int().nonnegative().default(0),
  paymentTerms: z.string().max(200).optional(),
  creationKey: z.string().min(8).max(200),
});

export async function POST(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ADMIN_ROLES as unknown as ("ADMIN")[]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const load = await prisma.freightLoad.findUnique({ where: { id: parsed.data.loadId } });
  if (!load) return NextResponse.json({ error: "Load not found." }, { status: 404 });

  try {
    await assertFreightAllowed({ capability: "directShipperQuoting", userRole: authed.role, marketId: load.marketId, requireAdmin: true });
  } catch (e) {
    if (e instanceof FreightGateError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  // Idempotency: existing invoice by creationKey or invoiceNumber → return it.
  const existing = await prisma.customerInvoice.findFirst({ where: { OR: [{ creationKey: parsed.data.creationKey }, { invoiceNumber: parsed.data.invoiceNumber }] } });
  if (existing) return NextResponse.json({ invoice: existing, idempotent: true });

  const totalCents = parsed.data.chargesCents + parsed.data.accessorialsCents + parsed.data.taxCents;

  const invoice = await prisma.$transaction(async (tx) => {
    const inv = await tx.customerInvoice.create({
      data: {
        loadId: load.id, invoiceNumber: parsed.data.invoiceNumber, chargesCents: parsed.data.chargesCents,
        accessorialsCents: parsed.data.accessorialsCents, taxCents: parsed.data.taxCents, totalCents,
        paymentTerms: parsed.data.paymentTerms, status: "DRAFT", creationKey: parsed.data.creationKey,
      },
    });
    await tx.freightAuditEvent.create({ data: { loadId: load.id, event: "INVOICE_CREATED", actorId: authed.userId, detail: { invoiceNumber: inv.invoiceNumber, totalCents } } });
    return inv;
  });
  return NextResponse.json({ invoice }, { status: 201 });
}
