import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { claimFreightLoad } from "@/lib/freight-claim";
import { queueNotification } from "@/lib/notifications";
import { invitationResponseTemplate } from "@/lib/email/templates/booking";

/**
 * A driver accepts a freight load invitation — uses the exact same
 * claimFreightLoad() the open board's request route uses, per the
 * explicit business rule to share the atomic claim logic. This is what
 * makes "invitation acceptance must respect remaining worker slots"
 * (here: the load can only ever have one assigned driver, so "slots"
 * means "not already assigned to someone else") true without a second,
 * separately-written race condition to get right.
 */
export async function POST(request: Request, context: { params: Promise<{ invitationId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["DRIVER"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { invitationId } = await context.params;

  const worker = await prisma.workerProfile.findUnique({ where: { userId: authed.userId } });
  if (!worker) return NextResponse.json({ error: "Worker profile not found." }, { status: 404 });

  const invitation = await prisma.carrierRouteInvitation.findUnique({ where: { id: invitationId } });
  if (!invitation) return NextResponse.json({ error: "Invitation not found." }, { status: 404 });
  if (invitation.workerId !== worker.id) return NextResponse.json({ error: "This invitation is not yours." }, { status: 403 });
  if (invitation.status !== "PENDING") {
    return NextResponse.json({ error: `This invitation is ${invitation.status.toLowerCase()} and can no longer be accepted.` }, { status: 409 });
  }
  if (invitation.expiresAt && invitation.expiresAt < new Date()) {
    await prisma.carrierRouteInvitation.update({ where: { id: invitationId }, data: { status: "EXPIRED" } });
    return NextResponse.json({ error: "This invitation has expired." }, { status: 409 });
  }

  const result = await claimFreightLoad(invitation.carrierRouteId, worker.id, authed.userId, "LOAD_ASSIGNED_VIA_INVITATION");
  if (!result.ok) {
    return NextResponse.json({ error: "This load is no longer available — it may have already been assigned." }, { status: 409 });
  }

  await prisma.carrierRouteInvitation.update({ where: { id: invitationId }, data: { status: "ACCEPTED", respondedAt: new Date() } });

  const load = await prisma.carrierRoute.findUnique({ where: { id: invitation.carrierRouteId } });
  if (load?.postedByUserId) {
    const poster = await prisma.user.findUnique({ where: { id: load.postedByUserId } });
    if (poster) {
      const notice = invitationResponseTemplate({ customerName: poster.firstName, workerName: worker.displayName ?? "A driver", entityTitle: load.title, accepted: true });
      await queueNotification({
        userId: poster.id, type: "INVITATION_RESPONSE", channels: ["EMAIL", "IN_APP"],
        title: notice.subject, body: notice.text, html: notice.html, idempotencyKey: `invitation-response:${invitationId}:ACCEPTED`,
      });
    }
  }

  return NextResponse.json({ load: result.load });
}
