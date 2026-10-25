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
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { runFmcsaCheck } from "@/lib/carriers/fmcsa";

/**
 * Admin-triggered FMCSA re-check (gap contract). Runs the (gated) verification
 * and persists a new dated CarrierFmcsaCheck snapshot. runFmcsaCheck never
 * throws — a provider outage is captured as checkError, never surfaced as a
 * carrier rejection. Admin-only.
 */
const ADMIN_ROLES = ["ADMIN", "SUPPORT", "FINANCE_ADMIN", "SUPER_ADMIN"] as const;

export async function POST(request: Request, { params }: { params: Promise<{ carrierId: string }> }) {
  const { carrierId } = await params;
  try { await requireRole(request, ADMIN_ROLES as unknown as ("ADMIN")[]); }
  catch (e) { if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; }

  const carrier = await prisma.carrier.findUnique({ where: { id: carrierId }, select: { id: true, dotNumber: true, mcNumber: true } });
  if (!carrier) return NextResponse.json({ error: "Carrier not found." }, { status: 404 });

  const snapshot = await runFmcsaCheck({ dotNumber: carrier.dotNumber ?? undefined, mcNumber: carrier.mcNumber ?? undefined });
  const check = await prisma.carrierFmcsaCheck.create({
    data: {
      carrierId: carrier.id, dotNumber: snapshot.dotNumber, mcNumber: snapshot.mcNumber,
      operatingStatus: snapshot.operatingStatus, authorized: snapshot.authorized,
      sourceResult: snapshot.sourceResult ?? undefined, checkedAt: new Date(snapshot.checkedAt), checkError: snapshot.checkError,
    },
  });
  return NextResponse.json({ check });
}
