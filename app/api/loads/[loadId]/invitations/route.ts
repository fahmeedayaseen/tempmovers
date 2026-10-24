import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { inviteDriverToLoad } from "@/lib/loads/invite-driver";

/**
 * A customer/partner invites a specific driver to a freight load —
 * uses the existing CarrierRouteInvitation model, which already had
 * the right shape (status, expiresAt, respondedAt) but no route that
 * ever created one for a direct, customer-initiated invitation (it
 * previously only existed as a concept the request route's
 * PRIVATE_CONFIDENTIAL/PREFERRED_NETWORK visibility gates checked
 * against).
 *
 * Phase 4 (Freight Invitations): the actual eligibility/upsert/notify
 * logic moved to lib/loads/invite-driver.ts's inviteDriverToLoad, so
 * this route and the new bulk route enforce identical rules — this
 * file now just does the load-level checks (ownership, load open) and
 * optional template resolution, then delegates.
 */
const schema = z.object({ workerId: z.string().cuid(), expirationHours: z.number().min(0.25).max(72).optional(), templateId: z.string().cuid().optional() });

/**
 * A customer's view of invitations they've sent for a specific load —
 * the freight equivalent of GET /api/jobs/[jobId]/invitations.
 */
export async function GET(request: Request, context: { params: Promise<{ loadId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["CUSTOMER", "ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { loadId } = await context.params;

  const load = await prisma.carrierRoute.findUnique({ where: { id: loadId } });
  if (!load) return NextResponse.json({ error: "Load not found." }, { status: 404 });
  if (authed.role === "CUSTOMER" && load.postedByUserId !== authed.userId) {
    return NextResponse.json({ error: "Not your load." }, { status: 403 });
  }

  const invitations = await prisma.carrierRouteInvitation.findMany({
    where: { carrierRouteId: loadId },
    select: { id: true, status: true, expiresAt: true, respondedAt: true, createdAt: true, worker: { select: { id: true, displayName: true } } },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ invitations });
}

export async function POST(request: Request, context: { params: Promise<{ loadId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["CUSTOMER", "ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { loadId } = await context.params;

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const load = await prisma.carrierRoute.findUnique({ where: { id: loadId } });
  if (!load) return NextResponse.json({ error: "Load not found." }, { status: 404 });
  if (authed.role === "CUSTOMER" && load.postedByUserId !== authed.userId) {
    return NextResponse.json({ error: "Not your load." }, { status: 403 });
  }

  let template: { subject: string; body: string } | undefined;
  if (parsed.data.templateId) {
    const row = await prisma.invitationTemplate.findUnique({ where: { id: parsed.data.templateId } });
    if (!row || row.ownerUserId !== authed.userId) {
      return NextResponse.json({ error: "Invitation template not found." }, { status: 404 });
    }
    template = { subject: row.subject, body: row.body };
  }

  const result = await inviteDriverToLoad({ load, workerId: parsed.data.workerId, expirationHours: parsed.data.expirationHours, template });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  await prisma.auditLog.create({
    data: { actorId: authed.userId, action: "LOAD_INVITATION_SENT", entityType: "CarrierRouteInvitation", entityId: result.invitationId, details: { loadId, workerId: result.workerId, templateId: parsed.data.templateId ?? null } },
  });

  const invitation = await prisma.carrierRouteInvitation.findUnique({ where: { id: result.invitationId } });
  return NextResponse.json({ invitation }, { status: 201 });
}
