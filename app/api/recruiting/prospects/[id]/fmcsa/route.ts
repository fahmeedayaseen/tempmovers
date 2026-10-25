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
import { requireRecruiter, AuthError } from "@/lib/recruiting/guard";
import { runFmcsaCheck } from "@/lib/carriers/fmcsa";

/**
 * FMCSA lookup for a prospect (recruiting CRM). Read-only qualification tool —
 * does NOT persist a CarrierFmcsaCheck (that's for real carriers). Returns a
 * normalized display state. A provider outage returns PROVIDER_UNAVAILABLE,
 * never a "not authorized" result.
 */
type FmcsaLookupState = "AUTHORIZED" | "NOT_AUTHORIZED" | "OUT_OF_SERVICE" | "NOT_FOUND" | "PROVIDER_UNAVAILABLE" | "STALE";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try { await requireRecruiter(request); }
  catch (e) { if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; }
  const prospect = await prisma.carrierProspect.findUnique({ where: { id: id }, select: { dotNumber: true, mcNumber: true } });
  if (!prospect) return NextResponse.json({ error: "Prospect not found." }, { status: 404 });

  const snap = await runFmcsaCheck({ dotNumber: prospect.dotNumber ?? undefined, mcNumber: prospect.mcNumber ?? undefined });
  let state: FmcsaLookupState;
  if (snap.checkError) state = snap.checkError.includes("No FMCSA record") ? "NOT_FOUND" : "PROVIDER_UNAVAILABLE";
  else if (snap.authorized === true) state = "AUTHORIZED";
  else if (snap.authorized === false) state = snap.operatingStatus === "OUT_OF_SERVICE" ? "OUT_OF_SERVICE" : "NOT_AUTHORIZED";
  else state = "PROVIDER_UNAVAILABLE";
  return NextResponse.json({ state, checkedAt: snap.checkedAt });
}
