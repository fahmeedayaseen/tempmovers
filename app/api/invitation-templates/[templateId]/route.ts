import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";

const updateSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  subject: z.string().min(1).max(200).optional(),
  body: z.string().min(1).max(4000).optional(),
});

export async function PATCH(request: Request, context: { params: Promise<{ templateId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["CUSTOMER", "ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { templateId } = await context.params;

  const parsed = updateSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  if (Object.keys(parsed.data).length === 0) return NextResponse.json({ error: "Nothing to update." }, { status: 400 });

  const existing = await prisma.invitationTemplate.findUnique({ where: { id: templateId } });
  if (!existing || existing.ownerUserId !== authed.userId) {
    return NextResponse.json({ error: "Invitation template not found." }, { status: 404 });
  }

  const template = await prisma.invitationTemplate.update({ where: { id: templateId }, data: parsed.data });

  await prisma.auditLog.create({
    data: { actorId: authed.userId, action: "INVITATION_TEMPLATE_UPDATED", entityType: "InvitationTemplate", entityId: template.id, details: { fields: Object.keys(parsed.data) } },
  });

  return NextResponse.json({ template });
}

export async function DELETE(request: Request, context: { params: Promise<{ templateId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["CUSTOMER", "ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { templateId } = await context.params;

  const existing = await prisma.invitationTemplate.findUnique({ where: { id: templateId } });
  if (!existing || existing.ownerUserId !== authed.userId) {
    return NextResponse.json({ error: "Invitation template not found." }, { status: 404 });
  }

  await prisma.invitationTemplate.delete({ where: { id: templateId } });

  await prisma.auditLog.create({
    data: { actorId: authed.userId, action: "INVITATION_TEMPLATE_DELETED", entityType: "InvitationTemplate", entityId: templateId, details: { name: existing.name } },
  });

  return NextResponse.json({ deleted: true });
}
