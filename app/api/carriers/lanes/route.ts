import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";

/** Carrier preferred-lanes CRUD (gap contract #6). Carrier-scoped by ownerUserId.
 * Feeds readiness + future load matching. */
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
  const lanes = await prisma.carrierLane.findMany({ where: { carrierId }, orderBy: { createdAt: "asc" } });
  return NextResponse.json({ lanes });
}

const createSchema = z.object({
  originState: z.string().max(2).optional(),
  originMetro: z.string().max(120).optional(),
  destinationState: z.string().max(2).optional(),
  destinationMetro: z.string().max(120).optional(),
});

export async function POST(request: Request) {
  let authed;
  try { authed = await requireRole(request, ["CARRIER", "ADMIN", "SUPER_ADMIN"] as unknown as ("ADMIN")[]); }
  catch (e) { if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; }
  const carrierId = await resolveCarrierId(authed.userId);
  if (!carrierId) return NextResponse.json({ error: "No carrier profile." }, { status: 404 });
  const parsed = createSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const lane = await prisma.carrierLane.create({ data: { carrierId, ...parsed.data } });
  return NextResponse.json({ lane }, { status: 201 });
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
  const existing = await prisma.carrierLane.findUnique({ where: { id: parsed.data.id }, select: { carrierId: true } });
  if (!existing || existing.carrierId !== carrierId) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const { id, ...rest } = parsed.data;
  const lane = await prisma.carrierLane.update({ where: { id }, data: rest });
  return NextResponse.json({ lane });
}

export async function DELETE(request: Request) {
  let authed;
  try { authed = await requireRole(request, ["CARRIER", "ADMIN", "SUPER_ADMIN"] as unknown as ("ADMIN")[]); }
  catch (e) { if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; }
  const carrierId = await resolveCarrierId(authed.userId);
  if (!carrierId) return NextResponse.json({ error: "No carrier profile." }, { status: 404 });
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required." }, { status: 400 });
  const existing = await prisma.carrierLane.findUnique({ where: { id }, select: { carrierId: true } });
  if (!existing || existing.carrierId !== carrierId) return NextResponse.json({ error: "Not found." }, { status: 404 });
  await prisma.carrierLane.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
