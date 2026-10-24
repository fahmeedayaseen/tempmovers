import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRecruiter, AuthError } from "@/lib/recruiting/guard";

/** Prospect detail with its activity timeline + open tasks. Also POST to log an
 * activity (append-only). */
export async function GET(request: Request, { params }: { params: { id: string } }) {
  try { await requireRecruiter(request); }
  catch (e) { if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; }
  const prospect = await prisma.carrierProspect.findUnique({
    where: { id: params.id },
    include: { activities: { orderBy: { occurredAt: "desc" } }, tasks: { where: { completedAt: null }, orderBy: { dueAt: "asc" } } },
  });
  if (!prospect) return NextResponse.json({ error: "Prospect not found." }, { status: 404 });
  return NextResponse.json({ prospect });
}

const activitySchema = z.object({
  activityType: z.enum(["NOTE", "CALL", "EMAIL", "SMS"]),
  notes: z.string().max(4000).optional(),
  nextFollowUpAt: z.string().datetime().optional(),
});

export async function POST(request: Request, { params }: { params: { id: string } }) {
  let authed;
  try { authed = await requireRecruiter(request); }
  catch (e) { if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; }
  const parsed = activitySchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const d = parsed.data;
  const activity = await prisma.$transaction(async (tx) => {
    const a = await tx.carrierRecruitingActivity.create({
      data: { prospectId: params.id, activityType: d.activityType, notes: d.notes, performedById: authed.userId, nextFollowUpAt: d.nextFollowUpAt ? new Date(d.nextFollowUpAt) : undefined },
    });
    await tx.carrierProspect.update({ where: { id: params.id }, data: { lastContactAt: new Date(), ...(d.nextFollowUpAt ? { nextFollowUpAt: new Date(d.nextFollowUpAt) } : {}) } });
    return a;
  });
  return NextResponse.json({ activity }, { status: 201 });
}
