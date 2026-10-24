import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRecruiter, AuthError } from "@/lib/recruiting/guard";

/**
 * Send a carrier application invitation to a prospect (recruiting CRM). Records
 * the invitation as an append-only activity and advances the stage to
 * APPLICATION_SENT. Actual email/SMS send is handled by the notification
 * service (env-side); this records intent + timeline.
 */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  let authed;
  try { authed = await requireRecruiter(request); }
  catch (e) { if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; }

  const prospect = await prisma.carrierProspect.findUnique({ where: { id: params.id }, select: { id: true, contactEmail: true, recruitmentStage: true } });
  if (!prospect) return NextResponse.json({ error: "Prospect not found." }, { status: 404 });
  if (!prospect.contactEmail) return NextResponse.json({ error: "Prospect has no contact email." }, { status: 428 });

  await prisma.$transaction(async (tx) => {
    await tx.carrierRecruitingActivity.create({ data: { prospectId: params.id, activityType: "INVITATION_SENT", notes: `Invitation sent to ${prospect.contactEmail}`, performedById: authed.userId } });
    // Only advance forward if still early in the pipeline.
    if (["NEW_LEAD", "CONTACT_ATTEMPTED", "CONTACTED", "INTERESTED"].includes(prospect.recruitmentStage)) {
      await tx.carrierProspect.update({ where: { id: params.id }, data: { recruitmentStage: "APPLICATION_SENT", lastContactAt: new Date() } });
    }
  });
  return NextResponse.json({ ok: true, note: "Invitation recorded. Delivery is handled by the notification service." });
}
