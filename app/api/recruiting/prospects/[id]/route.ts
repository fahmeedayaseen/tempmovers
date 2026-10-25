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
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRecruiter, AuthError } from "@/lib/recruiting/guard";

/** Prospect detail with its activity timeline + open tasks. Also POST to log an
 * activity (append-only). */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try { await requireRecruiter(request); }
  catch (e) { if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; }
  const prospect = await prisma.carrierProspect.findUnique({
    where: { id: id },
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

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let authed;
  try { authed = await requireRecruiter(request); }
  catch (e) { if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; }
  const parsed = activitySchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const d = parsed.data;
  const activity = await prisma.$transaction(async (tx) => {
    const a = await tx.carrierRecruitingActivity.create({
      data: { prospectId: id, activityType: d.activityType, notes: d.notes, performedById: authed.userId, nextFollowUpAt: d.nextFollowUpAt ? new Date(d.nextFollowUpAt) : undefined },
    });
    await tx.carrierProspect.update({ where: { id: id }, data: { lastContactAt: new Date(), ...(d.nextFollowUpAt ? { nextFollowUpAt: new Date(d.nextFollowUpAt) } : {}) } });
    return a;
  });
  return NextResponse.json({ activity }, { status: 201 });
}
