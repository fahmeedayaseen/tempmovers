import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { DISPATCHER_PERMISSIONS } from "@/lib/dispatcher/access";

/**
 * Dispatcher access GRANT management. This is a CARRIER-side action: the carrier
 * owner (or an admin acting for them) grants/revokes a dispatcher's access and
 * sets the permission set. Dispatchers cannot grant themselves access.
 *
 * POST body: { dispatcherId, carrierId, permissions[], expiresAt? }
 * PATCH body: { id, status?, permissions? }  (revoke / adjust)
 */
const CARRIER_OR_ADMIN = ["CARRIER", "ADMIN", "SUPER_ADMIN"] as const;

async function assertOwnsCarrier(userId: string, role: string, carrierId: string): Promise<boolean> {
  if (role === "ADMIN" || role === "SUPER_ADMIN") return true;
  const c = await prisma.carrier.findUnique({ where: { id: carrierId }, select: { ownerUserId: true } });
  return !!c && c.ownerUserId === userId;
}

const grantSchema = z.object({
  dispatcherId: z.string().min(1),
  carrierId: z.string().min(1),
  permissions: z.array(z.enum(DISPATCHER_PERMISSIONS)).min(1),
  expiresAt: z.string().datetime().optional(),
});

export async function POST(request: Request) {
  let authed;
  try { authed = await requireRole(request, CARRIER_OR_ADMIN as unknown as ("ADMIN")[]); }
  catch (e) { if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; }
  const parsed = grantSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const d = parsed.data;

  if (!(await assertOwnsCarrier(authed.userId, authed.role, d.carrierId))) {
    return NextResponse.json({ error: "You can only grant access for your own carrier." }, { status: 403 });
  }

  const access = await prisma.dispatcherCarrierAccess.upsert({
    where: { dispatcherId_carrierId: { dispatcherId: d.dispatcherId, carrierId: d.carrierId } },
    create: { dispatcherId: d.dispatcherId, carrierId: d.carrierId, permissions: d.permissions, status: "ACTIVE", grantedById: authed.userId, grantedAt: new Date(), expiresAt: d.expiresAt ? new Date(d.expiresAt) : undefined },
    update: { permissions: d.permissions, status: "ACTIVE", grantedById: authed.userId, grantedAt: new Date(), revokedAt: null, expiresAt: d.expiresAt ? new Date(d.expiresAt) : null },
  });
  return NextResponse.json({ access }, { status: 201 });
}

const patchSchema = z.object({ id: z.string().min(1), status: z.enum(["ACTIVE", "REVOKED"]).optional(), permissions: z.array(z.enum(DISPATCHER_PERMISSIONS)).optional() });

export async function PATCH(request: Request) {
  let authed;
  try { authed = await requireRole(request, CARRIER_OR_ADMIN as unknown as ("ADMIN")[]); }
  catch (e) { if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; }
  const parsed = patchSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const existing = await prisma.dispatcherCarrierAccess.findUnique({ where: { id: parsed.data.id }, select: { carrierId: true } });
  if (!existing) return NextResponse.json({ error: "Access grant not found." }, { status: 404 });
  if (!(await assertOwnsCarrier(authed.userId, authed.role, existing.carrierId))) {
    return NextResponse.json({ error: "You can only manage access for your own carrier." }, { status: 403 });
  }
  const { id, status, permissions } = parsed.data;
  const access = await prisma.dispatcherCarrierAccess.update({
    where: { id },
    data: { ...(permissions ? { permissions } : {}), ...(status ? { status, ...(status === "REVOKED" ? { revokedAt: new Date() } : {}) } : {}) },
  });
  return NextResponse.json({ access });
}
