import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";

/** Carrier equipment CRUD (gap contract #5). Carrier-scoped by ownerUserId.
 * Feeds the readiness dashboard supply counts and future load matching. */
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
  const equipment = await prisma.carrierEquipment.findMany({ where: { carrierId }, orderBy: { createdAt: "asc" } });
  return NextResponse.json({ equipment });
}

const createSchema = z.object({
  equipmentType: z.string().min(1).max(60),
  year: z.number().int().min(1980).max(2100).optional(),
  make: z.string().max(60).optional(),
  unitNumber: z.string().max(40).optional(),
  vinLast6: z.string().max(6).optional(),
  hasLiftgate: z.boolean().optional(),
});

export async function POST(request: Request) {
  let authed;
  try { authed = await requireRole(request, ["CARRIER", "ADMIN", "SUPER_ADMIN"] as unknown as ("ADMIN")[]); }
  catch (e) { if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; }
  const carrierId = await resolveCarrierId(authed.userId);
  if (!carrierId) return NextResponse.json({ error: "No carrier profile." }, { status: 404 });
  const parsed = createSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const equipment = await prisma.carrierEquipment.create({ data: { carrierId, ...parsed.data, hasLiftgate: parsed.data.hasLiftgate ?? false } });
  return NextResponse.json({ equipment }, { status: 201 });
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
  const existing = await prisma.carrierEquipment.findUnique({ where: { id: parsed.data.id }, select: { carrierId: true } });
  if (!existing || existing.carrierId !== carrierId) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const { id, ...rest } = parsed.data;
  const equipment = await prisma.carrierEquipment.update({ where: { id }, data: rest });
  return NextResponse.json({ equipment });
}

export async function DELETE(request: Request) {
  let authed;
  try { authed = await requireRole(request, ["CARRIER", "ADMIN", "SUPER_ADMIN"] as unknown as ("ADMIN")[]); }
  catch (e) { if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; }
  const carrierId = await resolveCarrierId(authed.userId);
  if (!carrierId) return NextResponse.json({ error: "No carrier profile." }, { status: 404 });
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required." }, { status: 400 });
  const existing = await prisma.carrierEquipment.findUnique({ where: { id }, select: { carrierId: true } });
  if (!existing || existing.carrierId !== carrierId) return NextResponse.json({ error: "Not found." }, { status: 404 });
  await prisma.carrierEquipment.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
