import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRecruiter, AuthError } from "@/lib/recruiting/guard";

/** Recruiting task/reminder system. */
export async function GET(request: Request) {
  let authed;
  try { authed = await requireRecruiter(request); }
  catch (e) { if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; }
  const url = new URL(request.url);
  const mine = url.searchParams.get("mine") === "true";
  const openOnly = url.searchParams.get("open") !== "false";
  const tasks = await prisma.recruitingTask.findMany({
    where: { ...(mine ? { assignedToId: authed.userId } : {}), ...(openOnly ? { completedAt: null } : {}) },
    orderBy: { dueAt: "asc" }, take: 500,
  });
  return NextResponse.json({ tasks });
}

const createSchema = z.object({ title: z.string().min(1).max(300), prospectId: z.string().optional(), dueAt: z.string().datetime().optional(), assignedToId: z.string().optional() });

export async function POST(request: Request) {
  let authed;
  try { authed = await requireRecruiter(request); }
  catch (e) { if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; }
  const parsed = createSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const d = parsed.data;
  const task = await prisma.recruitingTask.create({ data: { title: d.title, prospectId: d.prospectId, dueAt: d.dueAt ? new Date(d.dueAt) : undefined, assignedToId: d.assignedToId ?? authed.userId, createdById: authed.userId } });
  return NextResponse.json({ task }, { status: 201 });
}

const patchSchema = z.object({ id: z.string().min(1), completed: z.boolean().optional(), title: z.string().max(300).optional(), dueAt: z.string().datetime().optional() });

export async function PATCH(request: Request) {
  try { await requireRecruiter(request); }
  catch (e) { if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; }
  const parsed = patchSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const { id, completed, dueAt, ...rest } = parsed.data;
  const task = await prisma.recruitingTask.update({
    where: { id },
    data: { ...rest, ...(dueAt ? { dueAt: new Date(dueAt) } : {}), ...(completed === undefined ? {} : { completedAt: completed ? new Date() : null }) },
  });
  return NextResponse.json({ task });
}
