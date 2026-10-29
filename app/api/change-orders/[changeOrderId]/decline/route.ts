import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { stripe } from "@/lib/stripe";
import { requireRole, AuthError } from "@/lib/auth";

/**
 * Decline a change order — VASRUE Digital Media, 29 October 2026.
 *
 * POST /api/change-orders/[id]/decline (the job's customer). The crew then
 * does only the funded original scope (payment spec §3). An unfinished
 * payment for the change is canceled; a change that is already paid cannot be
 * declined (refunds go through the refund flow).
 */
export async function POST(request: Request, context: { params: Promise<{ changeOrderId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["CUSTOMER", "ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { changeOrderId } = await context.params;
  const order = await prisma.changeOrder.findUnique({ where: { id: changeOrderId } });
  if (!order || order.entityType !== "JOB") return NextResponse.json({ error: "Change not found." }, { status: 404 });
  const job = await prisma.job.findUnique({ where: { id: order.entityId }, include: { customer: true } });
  if (!job) return NextResponse.json({ error: "Job not found." }, { status: 404 });
  if (authed.role === "CUSTOMER" && job.customer.userId !== authed.userId) return NextResponse.json({ error: "Not your job." }, { status: 403 });
  if (order.status === "PAID") return NextResponse.json({ error: "This change is already paid." }, { status: 409 });
  if (order.status === "DECLINED" || order.status === "CANCELED") return NextResponse.json({ error: `This change was already ${order.status.toLowerCase()}.` }, { status: 409 });

  const attempt = await prisma.fundingAttempt.findUnique({ where: { changeOrderId: order.id } });
  if (attempt) {
    const intent = await stripe.paymentIntents.retrieve(attempt.stripePaymentIntentId);
    if (intent.status === "succeeded" || intent.status === "processing") {
      return NextResponse.json({ error: "The payment for this change already went through." }, { status: 409 });
    }
    if (intent.status !== "canceled") await stripe.paymentIntents.cancel(intent.id, { cancellation_reason: "requested_by_customer" }).catch(() => undefined);
    await prisma.fundingAttempt.update({ where: { id: attempt.id }, data: { state: "CANCELED", lastSyncedAt: new Date() } });
  }

  await prisma.changeOrder.update({ where: { id: order.id }, data: { status: "DECLINED", declinedAt: new Date() } });
  await prisma.auditLog.create({ data: { actorId: authed.userId, jobId: job.id, action: "CHANGE_ORDER_DECLINED", entityType: "ChangeOrder", entityId: order.id, details: { deltaCents: order.deltaCents } } });
  return NextResponse.json({ declined: true });
}
