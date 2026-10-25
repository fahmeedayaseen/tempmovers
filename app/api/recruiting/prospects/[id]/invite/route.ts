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
 * Send a carrier application invitation to a prospect (recruiting CRM). Records
 * the invitation as an append-only activity and advances the stage to
 * APPLICATION_SENT. Actual email/SMS send is handled by the notification
 * service (env-side); this records intent + timeline.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let authed;
  try { authed = await requireRecruiter(request); }
  catch (e) { if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; }

  const prospect = await prisma.carrierProspect.findUnique({ where: { id: id }, select: { id: true, contactEmail: true, recruitmentStage: true } });
  if (!prospect) return NextResponse.json({ error: "Prospect not found." }, { status: 404 });
  if (!prospect.contactEmail) return NextResponse.json({ error: "Prospect has no contact email." }, { status: 428 });

  await prisma.$transaction(async (tx) => {
    await tx.carrierRecruitingActivity.create({ data: { prospectId: id, activityType: "INVITATION_SENT", notes: `Invitation sent to ${prospect.contactEmail}`, performedById: authed.userId } });
    // Only advance forward if still early in the pipeline.
    if (["NEW_LEAD", "CONTACT_ATTEMPTED", "CONTACTED", "INTERESTED"].includes(prospect.recruitmentStage)) {
      await tx.carrierProspect.update({ where: { id: id }, data: { recruitmentStage: "APPLICATION_SENT", lastContactAt: new Date() } });
    }
  });
  return NextResponse.json({ ok: true, note: "Invitation recorded. Delivery is handled by the notification service." });
}
