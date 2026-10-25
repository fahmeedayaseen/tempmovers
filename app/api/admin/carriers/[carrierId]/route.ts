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

/**
 * Admin carrier DETAIL (gap contract). Returns one carrier with everything a
 * reviewer needs: scalars, documents, insurance, equipment, lanes, agreements,
 * factoring profile + active assignment, latest FMCSA check, status history,
 * and internal notes. Admin-only.
 */
const ADMIN_ROLES = ["ADMIN", "SUPPORT", "FINANCE_ADMIN", "SUPER_ADMIN"] as const;

export async function GET(request: Request, { params }: { params: Promise<{ carrierId: string }> }) {
  const { carrierId } = await params;
  try { await requireRole(request, ADMIN_ROLES as unknown as ("ADMIN")[]); }
  catch (e) { if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; }

  const carrier = await prisma.carrier.findUnique({
    where: { id: carrierId },
    include: {
      documents: { orderBy: { createdAt: "desc" } },
      insurancePolicies: true,
      equipment: true,
      lanes: true,
      agreements: true,
      fmcsaChecks: { orderBy: { checkedAt: "desc" }, take: 1 },
      statusEvents: { orderBy: { createdAt: "desc" } },
      notes: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!carrier) return NextResponse.json({ error: "Carrier not found." }, { status: 404 });

  const factoringProfile = await prisma.carrierFactoringProfile.findUnique({ where: { carrierId: carrier.id } });
  const activeAssignment = await prisma.paymentAssignment.findFirst({ where: { carrierId: carrier.id, status: "ACTIVE" } });

  return NextResponse.json({ carrier, factoringProfile, activeAssignment });
}
