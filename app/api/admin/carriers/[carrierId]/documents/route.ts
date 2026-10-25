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

/**
 * Admin document review (gap contract). Approve, reject (with reason), or
 * supersede a carrier document. Mirrors the worker-review pattern. Sets the
 * CarrierDocument fields the portal reads (verified / rejectionReason /
 * supersededById+supersededAt). Admin-only.
 */
const ADMIN_ROLES = ["ADMIN", "SUPPORT", "FINANCE_ADMIN", "SUPER_ADMIN"] as const;

const schema = z.object({
  documentId: z.string().min(1),
  decision: z.enum(["APPROVE", "REJECT", "SUPERSEDE"]),
  reason: z.string().max(1000).optional(),
  supersededById: z.string().optional(),
});

export async function PATCH(request: Request, { params }: { params: Promise<{ carrierId: string }> }) {
  const { carrierId } = await params;
  let authed;
  try { authed = await requireRole(request, ADMIN_ROLES as unknown as ("ADMIN")[]); }
  catch (e) { if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; }

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const { documentId, decision, reason, supersededById } = parsed.data;

  const doc = await prisma.carrierDocument.findUnique({ where: { id: documentId }, select: { carrierId: true } });
  if (!doc || doc.carrierId !== carrierId) return NextResponse.json({ error: "Document not found." }, { status: 404 });

  if (decision === "REJECT" && !reason) return NextResponse.json({ error: "A rejection reason is required." }, { status: 400 });

  const data =
    decision === "APPROVE" ? { verified: true, rejectionReason: null }
    : decision === "REJECT" ? { verified: false, rejectionReason: reason }
    : { supersededById: supersededById ?? null, supersededAt: new Date() };

  const document = await prisma.carrierDocument.update({ where: { id: documentId }, data });
  return NextResponse.json({ document, reviewedBy: authed.userId });
}
