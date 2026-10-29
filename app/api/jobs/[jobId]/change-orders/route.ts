import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { queueNotification } from "@/lib/notifications";
import { changeOrderRequestSchema, ChangeOrderError, nextChangeOrderVersion, priceChangeOrder } from "@/lib/payments/change-orders";

/**
 * Change orders on a job — VASRUE Digital Media, 29 October 2026.
 *
 * GET  — the job's change orders, for its customer, its assigned crew, or admin.
 * POST — propose one (admin, or a crew member checked in or booked on the job).
 *        The server prices it; nothing in the request sets the amount except an
 *        admin's OTHER order. The customer approves and pays it through
 *        POST /api/change-orders/[id]/accept before the added work starts
 *        (payment spec §3, §6).
 */
const CREW_STATUSES = ["ACCEPTED", "CHECKED_IN", "CHECKED_OUT"];

async function access(jobId: string, userId: string, role: string) {
  const job = await prisma.job.findUnique({ where: { id: jobId }, include: { customer: true } });
  if (!job) return { job: null, as: null as null };
  if (role === "ADMIN") return { job, as: "ADMIN" as const };
  if (role === "CUSTOMER" && job.customer.userId === userId) return { job, as: "CUSTOMER" as const };
  if (role === "MOVER" || role === "DRIVER") {
    const worker = await prisma.workerProfile.findUnique({ where: { userId }, select: { id: true } });
    const seat = worker ? await prisma.assignment.findFirst({ where: { jobId, workerId: worker.id, status: { in: CREW_STATUSES as never } } }) : null;
    if (seat) return { job, as: "CREW" as const };
  }
  return { job, as: null as null };
}

export async function GET(request: Request, context: { params: Promise<{ jobId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["CUSTOMER", "MOVER", "DRIVER", "ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { jobId } = await context.params;
  const { job, as } = await access(jobId, authed.userId, authed.role);
  if (!job) return NextResponse.json({ error: "Job not found." }, { status: 404 });
  if (!as) return NextResponse.json({ error: "Not your job." }, { status: 403 });

  const orders = await prisma.changeOrder.findMany({ where: { entityType: "JOB", entityId: jobId }, orderBy: { version: "asc" } });
  return NextResponse.json({
    changeOrders: orders.map((o) => ({
      id: o.id, version: o.version, kind: o.kind, status: o.status, deltaCents: o.deltaCents, lines: o.lines, reason: o.reason,
      createdAt: o.createdAt, acceptedAt: o.acceptedAt, paidAt: o.paidAt, declinedAt: o.declinedAt,
    })),
  });
}

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["MOVER", "DRIVER", "ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { jobId } = await context.params;
  const { job, as } = await access(jobId, authed.userId, authed.role);
  if (!job) return NextResponse.json({ error: "Job not found." }, { status: 404 });
  if (as !== "ADMIN" && as !== "CREW") return NextResponse.json({ error: "Only the crew on this job or an admin can propose a change." }, { status: 403 });
  if (["CANCELED", "COMPLETED", "DRAFT"].includes(job.status)) return NextResponse.json({ error: `A change can't be added to a ${job.status.toLowerCase()} job.` }, { status: 409 });

  const parsed = changeOrderRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  if (parsed.data.kind === "OTHER" && as !== "ADMIN") return NextResponse.json({ error: "Only an admin can add a custom amount." }, { status: 403 });

  const open = await prisma.changeOrder.count({ where: { entityType: "JOB", entityId: jobId, status: { in: ["PROPOSED", "ACCEPTED"] } } });
  if (open >= 3) return NextResponse.json({ error: "This job already has changes waiting on the customer." }, { status: 409 });

  let priced;
  try {
    priced = await priceChangeOrder(job, parsed.data);
  } catch (e) {
    if (e instanceof ChangeOrderError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const order = await prisma.changeOrder.create({
    data: {
      entityType: "JOB", entityId: jobId, version: await nextChangeOrderVersion(jobId), kind: parsed.data.kind, status: "PROPOSED",
      deltaCents: priced.deltaCents, lines: priced.lines as unknown as Prisma.InputJsonArray, plan: priced.plan as unknown as Prisma.InputJsonObject,
      reason: parsed.data.reason, proposedByUserId: authed.userId,
    },
  });
  await prisma.auditLog.create({ data: { actorId: authed.userId, jobId, action: "CHANGE_ORDER_PROPOSED", entityType: "ChangeOrder", entityId: order.id, details: { kind: order.kind, deltaCents: order.deltaCents, reason: order.reason } } });
  await queueNotification({
    userId: job.customer.userId, type: "CHANGE_ORDER_REQUESTED", channels: ["EMAIL", "IN_APP"],
    title: "Your crew asked to add to your job",
    body: `${order.reason}. The change is $${(order.deltaCents / 100).toFixed(2)}. Approve and pay it in your dashboard; the added work starts once it's paid.`,
    idempotencyKey: `change-order:${order.id}`,
  });

  return NextResponse.json({ changeOrder: { id: order.id, version: order.version, kind: order.kind, status: order.status, deltaCents: order.deltaCents, lines: order.lines, reason: order.reason } }, { status: 201 });
}
