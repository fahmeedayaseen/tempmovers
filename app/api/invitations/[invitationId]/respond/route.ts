import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { evaluateWorkerEligibility } from "@/lib/worker-eligibility";

const schema = z.object({ response: z.enum(["ACCEPTED", "DECLINED"]) });

export async function POST(request: Request, context: { params: Promise<{ invitationId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["MOVER", "DRIVER"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { invitationId } = await context.params;

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const invitation = await prisma.carrierRouteInvitation.findUnique({
    where: { id: invitationId },
    include: { worker: true, carrierRoute: true },
  });
  if (!invitation) return NextResponse.json({ error: "Invitation not found." }, { status: 404 });
  if (invitation.worker.userId !== authed.userId) {
    return NextResponse.json({ error: "This invitation is not yours." }, { status: 403 });
  }
  if (invitation.status !== "PENDING") {
    return NextResponse.json({ error: `Invitation already ${invitation.status.toLowerCase()}.` }, { status: 409 });
  }
  if (invitation.expiresAt && invitation.expiresAt < new Date()) {
    await prisma.carrierRouteInvitation.update({ where: { id: invitation.id }, data: { status: "EXPIRED" } });
    return NextResponse.json({ error: "This invitation has expired." }, { status: 409 });
  }
  if (parsed.data.response === "ACCEPTED") {
    const evaluation = await evaluateWorkerEligibility({ workerId: invitation.worker.id, context: "FREIGHT_LOAD_REQUEST", equipmentType: invitation.carrierRoute.equipmentType });
    if (!evaluation.allowed) {
      return NextResponse.json(
        { error: "Onboarding must be complete before accepting a load invitation.", missing: evaluation.missingRequirements },
        { status: 403 },
      );
    }
  }

  const updated = await prisma.carrierRouteInvitation.update({
    where: { id: invitation.id },
    data: { status: parsed.data.response, respondedAt: new Date() },
  });

  await prisma.auditLog.create({
    data: { actorId: authed.userId, action: `LOAD_INVITATION_${parsed.data.response}`, entityType: "CarrierRouteInvitation", entityId: invitation.id },
  });

  return NextResponse.json({ invitation: updated });
}
