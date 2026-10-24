import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";

/**
 * Carrier insurance CRUD (gap contract #2). Carrier-scoped by ownerUserId. The
 * CarrierInsurancePolicy model already exists; this adds the carrier-facing
 * write path the wizard's Insurance step needs. verification stays admin-side
 * (a policy row does not self-verify).
 */
const INSURANCE_TYPES = ["AUTO_LIABILITY", "CARGO", "GENERAL_LIABILITY"] as const;

async function resolveCarrierId(userId: string): Promise<string | null> {
  const c = await prisma.carrier.findUnique({ where: { ownerUserId: userId }, select: { id: true } });
  return c?.id ?? null;
}

export async function GET(request: Request) {
  let authed;
  try { authed = await requireRole(request, ["CARRIER", "ADMIN", "SUPER_ADMIN"] as unknown as ("ADMIN")[]); }
  catch (e) { if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; }
  const carrierId = await resolveCarrierId(authed.userId);
  if (!carrierId) return NextResponse.json({ error: "No carrier profile." }, { status: 404 });
  const policies = await prisma.carrierInsurancePolicy.findMany({ where: { carrierId }, orderBy: { type: "asc" } });
  return NextResponse.json({ policies });
}

const createSchema = z.object({
  type: z.enum(INSURANCE_TYPES),
  insurerName: z.string().max(200).optional(),
  policyNumber: z.string().max(120).optional(),
  coverageCents: z.number().int().nonnegative().optional(),
  effectiveAt: z.string().datetime().optional(),
  expiresAt: z.string().datetime().optional(),
  documentId: z.string().optional(),
});

export async function POST(request: Request) {
  let authed;
  try { authed = await requireRole(request, ["CARRIER", "ADMIN", "SUPER_ADMIN"] as unknown as ("ADMIN")[]); }
  catch (e) { if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; }
  const carrierId = await resolveCarrierId(authed.userId);
  if (!carrierId) return NextResponse.json({ error: "No carrier profile." }, { status: 404 });
  const parsed = createSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const d = parsed.data;
  const policy = await prisma.carrierInsurancePolicy.create({
    data: { carrierId, type: d.type, insurerName: d.insurerName, policyNumber: d.policyNumber, coverageCents: d.coverageCents,
      effectiveAt: d.effectiveAt ? new Date(d.effectiveAt) : undefined, expiresAt: d.expiresAt ? new Date(d.expiresAt) : undefined, documentId: d.documentId },
  });
  return NextResponse.json({ policy }, { status: 201 });
}

const updateSchema = createSchema.partial().extend({ id: z.string().min(1) });

export async function PATCH(request: Request) {
  let authed;
  try { authed = await requireRole(request, ["CARRIER", "ADMIN", "SUPER_ADMIN"] as unknown as ("ADMIN")[]); }
  catch (e) { if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; }
  const carrierId = await resolveCarrierId(authed.userId);
  if (!carrierId) return NextResponse.json({ error: "No carrier profile." }, { status: 404 });
  const parsed = updateSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  // Ownership: the policy must belong to the caller's carrier.
  const existing = await prisma.carrierInsurancePolicy.findUnique({ where: { id: parsed.data.id }, select: { carrierId: true } });
  if (!existing || existing.carrierId !== carrierId) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const { id, effectiveAt, expiresAt, ...rest } = parsed.data;
  const policy = await prisma.carrierInsurancePolicy.update({
    where: { id },
    data: { ...rest, effectiveAt: effectiveAt ? new Date(effectiveAt) : undefined, expiresAt: expiresAt ? new Date(expiresAt) : undefined },
  });
  return NextResponse.json({ policy });
}

export async function DELETE(request: Request) {
  let authed;
  try { authed = await requireRole(request, ["CARRIER", "ADMIN", "SUPER_ADMIN"] as unknown as ("ADMIN")[]); }
  catch (e) { if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; }
  const carrierId = await resolveCarrierId(authed.userId);
  if (!carrierId) return NextResponse.json({ error: "No carrier profile." }, { status: 404 });
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required." }, { status: 400 });
  const existing = await prisma.carrierInsurancePolicy.findUnique({ where: { id }, select: { carrierId: true } });
  if (!existing || existing.carrierId !== carrierId) return NextResponse.json({ error: "Not found." }, { status: 404 });
  await prisma.carrierInsurancePolicy.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
