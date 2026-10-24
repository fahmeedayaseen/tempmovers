import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";

/**
 * Freight invitation templates (Phase 4) — reusable subject/body pairs
 * a customer or partner can save and re-select instead of writing the
 * invitation message from scratch every time. Owner-scoped: a
 * customer only ever sees and can select their own templates. ADMIN
 * gets its own list too (its own templates, not everyone's) rather
 * than a cross-account view — there's no support workflow yet that
 * needs "see this customer's saved templates," and building that
 * visibility speculatively would be scope creep beyond what Phase 4
 * asked for.
 */
const createSchema = z.object({
  name: z.string().min(1).max(80),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(4000),
});

export async function GET(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["CUSTOMER", "ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const templates = await prisma.invitationTemplate.findMany({
    where: { ownerUserId: authed.userId },
    orderBy: { updatedAt: "desc" },
  });

  return NextResponse.json({ templates });
}

export async function POST(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["CUSTOMER", "ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const parsed = createSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const template = await prisma.invitationTemplate.create({
    data: { ownerUserId: authed.userId, name: parsed.data.name, subject: parsed.data.subject, body: parsed.data.body },
  });

  await prisma.auditLog.create({
    data: { actorId: authed.userId, action: "INVITATION_TEMPLATE_CREATED", entityType: "InvitationTemplate", entityId: template.id, details: { name: template.name } },
  });

  return NextResponse.json({ template }, { status: 201 });
}
