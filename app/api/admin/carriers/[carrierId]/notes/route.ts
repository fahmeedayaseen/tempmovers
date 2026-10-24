import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";

/** Internal admin notes on a carrier (gap contract). Admin-only; NEVER exposed
 * to the carrier (no carrier-facing route reads CarrierNote). */
const ADMIN_ROLES = ["ADMIN", "SUPPORT", "FINANCE_ADMIN", "SUPER_ADMIN"] as const;

export async function GET(request: Request, { params }: { params: { carrierId: string } }) {
  try { await requireRole(request, ADMIN_ROLES as unknown as ("ADMIN")[]); }
  catch (e) { if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; }
  const notes = await prisma.carrierNote.findMany({ where: { carrierId: params.carrierId }, orderBy: { createdAt: "desc" } });
  return NextResponse.json({ notes });
}

const schema = z.object({ body: z.string().min(1).max(4000) });

export async function POST(request: Request, { params }: { params: { carrierId: string } }) {
  let authed;
  try { authed = await requireRole(request, ADMIN_ROLES as unknown as ("ADMIN")[]); }
  catch (e) { if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; }
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const note = await prisma.carrierNote.create({ data: { carrierId: params.carrierId, body: parsed.data.body, authorId: authed.userId } });
  return NextResponse.json({ note }, { status: 201 });
}
