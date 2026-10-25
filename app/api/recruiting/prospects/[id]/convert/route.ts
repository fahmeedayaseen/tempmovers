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

/**
 * Convert a prospect into a Carrier record (recruiting CRM). Creates a Carrier
 * owned by the prospect's contact user if one is supplied, links the prospect
 * via convertedCarrierId (unique — a prospect converts once), and logs a
 * CONVERTED activity. Idempotent: if already converted, returns the existing
 * link. The new Carrier starts at APPLICATION_STARTED — conversion never skips
 * onboarding/compliance.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let authed;
  try { authed = await requireRecruiter(request); }
  catch (e) { if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; }

  const prospect = await prisma.carrierProspect.findUnique({ where: { id: id } });
  if (!prospect) return NextResponse.json({ error: "Prospect not found." }, { status: 404 });

  // Idempotent.
  if (prospect.convertedCarrierId) {
    return NextResponse.json({ carrierId: prospect.convertedCarrierId, alreadyConverted: true });
  }

  const body = await request.json().catch(() => ({}));
  const ownerUserId: string | undefined = body?.ownerUserId;
  if (!ownerUserId) return NextResponse.json({ error: "An ownerUserId is required to create the carrier account." }, { status: 428 });

  // Guard: a carrier may already exist for that user (one per owner).
  const existingCarrier = await prisma.carrier.findUnique({ where: { ownerUserId }, select: { id: true } });

  const result = await prisma.$transaction(async (tx) => {
    const carrier = existingCarrier ?? await tx.carrier.create({
      data: {
        ownerUserId, legalBusinessName: prospect.companyName,
        dotNumber: prospect.dotNumber ?? undefined, mcNumber: prospect.mcNumber ?? undefined,
        status: "APPLICATION_STARTED",
      },
    });
    await tx.carrierProspect.update({ where: { id: id }, data: { convertedCarrierId: carrier.id, recruitmentStage: "APPLICATION_STARTED" } });
    await tx.carrierRecruitingActivity.create({ data: { prospectId: id, activityType: "CONVERTED", notes: `Converted to carrier ${carrier.id}`, performedById: authed.userId } });
    return carrier;
  });
  return NextResponse.json({ carrierId: result.id }, { status: 201 });
}
