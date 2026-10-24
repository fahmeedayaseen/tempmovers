import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { queueNotification } from "@/lib/notifications";
import { invitationResponseTemplate } from "@/lib/email/templates/booking";

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
    return NextResponse.json({ error: `This invitation is ${invitation.status.toLowerCase()} and can no longer be declined.` }, { status: 409 });
  }

  const claim = await prisma.carrierRouteInvitation.updateMany({
    where: { id: invitationId, status: "PENDING" },
    data: { status: "DECLINED", respondedAt: new Date() },
  });
  if (claim.count !== 1) return NextResponse.json({ error: "This invitation was already responded to." }, { status: 409 });

  await prisma.auditLog.create({
    data: { actorId: authed.userId, action: "LOAD_INVITATION_DECLINED", entityType: "CarrierRouteInvitation", entityId: invitationId, details: { loadId: invitation.carrierRouteId } },
  });

  const load = await prisma.carrierRoute.findUnique({ where: { id: invitation.carrierRouteId } });
  if (load?.postedByUserId) {
    const poster = await prisma.user.findUnique({ where: { id: load.postedByUserId } });
    if (poster) {
      const notice = invitationResponseTemplate({ customerName: poster.firstName, workerName: worker.displayName ?? "A driver", entityTitle: load.title, accepted: false });
      await queueNotification({
        userId: poster.id, type: "INVITATION_RESPONSE", channels: ["EMAIL", "IN_APP"],
        title: notice.subject, body: notice.text, html: notice.html, idempotencyKey: `invitation-response:${invitationId}:DECLINED`,
      });
    }
  }

  const updated = await prisma.carrierRouteInvitation.findUnique({ where: { id: invitationId } });
  return NextResponse.json({ invitation: updated });
}
