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
import { isBrokerageCapabilityEnabled } from "@/lib/compliance/service-separation";

/**
 * Freight load DETAIL for the operations console (read contract). Admin-gated.
 * Returns the full load with stops, offers, rate confirmations, accessorials,
 * invoices, settlements, amendments, and the append-only audit trail — the
 * data behind the tabbed load workspace. Money stays integer cents; the UI
 * formats. Includes brokerage flag state.
 */
const OPS_ROLES = ["ADMIN", "FINANCE_ADMIN", "SUPER_ADMIN"] as const;

export async function GET(request: Request, { params }: { params: Promise<{ loadId: string }> }) {
  const { loadId } = await params;
  try { await requireRole(request, OPS_ROLES as unknown as ("ADMIN")[]); }
  catch (e) { if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; }

  const load = await prisma.freightLoad.findUnique({
    where: { id: loadId },
    include: {
      stops: { orderBy: { sequence: "asc" } },
      offers: { orderBy: { createdAt: "desc" } },
      rateConfirmations: { orderBy: { version: "desc" } },
      accessorials: { orderBy: { createdAt: "desc" } },
      invoices: true,
      settlements: true,
      amendments: { orderBy: { version: "desc" } },
      auditEvents: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!load) return NextResponse.json({ error: "Load not found." }, { status: 404 });

  // Settlement routing context (read-only; the destination itself is server-controlled).
  let activeAssignment = null;
  if (load.assignedCarrierId) {
    activeAssignment = await prisma.paymentAssignment.findFirst({ where: { carrierId: load.assignedCarrierId, status: "ACTIVE" }, select: { id: true, remitToName: true, status: true } });
  }

  const brokerageActive = await isBrokerageCapabilityEnabled("loadPosting");
  return NextResponse.json({ load, activeAssignment, brokerageActive });
}
