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

export async function POST(request: Request, { params }: { params: { carrierId: string } }) {
  try { await requireRole(request, ADMIN_ROLES as unknown as ("ADMIN")[]); }
  catch (e) { if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; }

  const carrier = await prisma.carrier.findUnique({ where: { id: params.carrierId }, select: { id: true, dotNumber: true, mcNumber: true } });
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
