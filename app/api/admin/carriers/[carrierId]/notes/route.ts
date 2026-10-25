// ---------------------------------------------------------------------------
// BLOCK-06 — VASRUE Digital Media, 24 October 2026.
// Next.js 15 made dynamic-route `params` a Promise. This file still used the
// Next 14 object form, which no longer satisfies the route-handler constraint
// Next generates into .next/types, so `next build` halted here.
//
// Note for anyone re-running the gate: `tsc --noEmit` does NOT catch this.
// The constraint only exists once Next has generated its route types, so a
// clean typecheck says nothing about it — only a real build does.
//
// The conversion is mechanical: Promise-typed params, await once at the top of
// the handler, then use the destructured value. No auth check, guard, query or
// response shape is altered by this change.
// ---------------------------------------------------------------------------
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";

/** Internal admin notes on a carrier (gap contract). Admin-only; NEVER exposed
 * to the carrier (no carrier-facing route reads CarrierNote). */
const ADMIN_ROLES = ["ADMIN", "SUPPORT", "FINANCE_ADMIN", "SUPER_ADMIN"] as const;

export async function GET(request: Request, { params }: { params: Promise<{ carrierId: string }> }) {
  const { carrierId } = await params;
  try { await requireRole(request, ADMIN_ROLES as unknown as ("ADMIN")[]); }
  catch (e) { if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; }
  const notes = await prisma.carrierNote.findMany({ where: { carrierId: carrierId }, orderBy: { createdAt: "desc" } });
  return NextResponse.json({ notes });
}

const schema = z.object({ body: z.string().min(1).max(4000) });

export async function POST(request: Request, { params }: { params: Promise<{ carrierId: string }> }) {
  const { carrierId } = await params;
  let authed;
  try { authed = await requireRole(request, ADMIN_ROLES as unknown as ("ADMIN")[]); }
  catch (e) { if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; }
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const note = await prisma.carrierNote.create({ data: { carrierId: carrierId, body: parsed.data.body, authorId: authed.userId } });
  return NextResponse.json({ note }, { status: 201 });
}
