import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { queueNotification } from "@/lib/notifications";
import { tipReceivedTemplate } from "@/lib/email/templates/payments";
import { attemptTipAllocation } from "@/lib/tip-split";
import { captureIntegrationAlert } from "@/lib/monitoring";

/**
 * Admin recovery for a PAID_UNALLOCATED tip — the customer's money was
 * already captured by Stripe, but the worker split/allocation couldn't
 * be completed at the time (e.g. the job's approved-assignment
 * eligibility changed between charge and webhook). Uses the exact same
 * attemptTipAllocation() the webhook itself calls, so a manual retry
 * and the original automatic attempt can never behave differently.
 */
export async function POST(request: Request, context: { params: Promise<{ tipId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { tipId } = await context.params;

  const tip = await prisma.tip.findUnique({ where: { id: tipId } });
  if (!tip) return NextResponse.json({ error: "Tip not found." }, { status: 404 });
  if (tip.status !== "PAID_UNALLOCATED") {
    return NextResponse.json({ error: `Tip status ${tip.status} is not eligible for a retry — only PAID_UNALLOCATED tips can be retried.` }, { status: 409 });
  }

  const result = await attemptTipAllocation(tip.id);

  await prisma.auditLog.create({
    data: {
      actorId: authed.userId, action: result.ok ? "TIP_ALLOCATION_RETRY_SUCCEEDED" : "TIP_ALLOCATION_RETRY_FAILED",
      entityType: "Tip", entityId: tip.id, details: result.ok ? { allocationIds: result.allocationIds } : { reason: result.reason },
    },
  });

  if (!result.ok) {
    captureIntegrationAlert("Tip allocation retry failed — still needs manual review.", { area: "payment", tipId: tip.id, reason: result.reason });
    return NextResponse.json({ error: result.reason }, { status: 409 });
  }

  const entity = tip.jobId
    ? await prisma.job.findUnique({ where: { id: tip.jobId }, select: { title: true } })
    : await prisma.carrierRoute.findUnique({ where: { id: tip.loadId! }, select: { title: true } });
  const createdAllocations = await prisma.tipAllocation.findMany({ where: { id: { in: result.allocationIds } } });
  for (const allocation of createdAllocations) {
    const worker = await prisma.workerProfile.findUnique({ where: { id: allocation.workerId } });
    if (worker) {
      const notice = tipReceivedTemplate({ workerName: worker.displayName ?? "there", amountCents: allocation.amountCents, entityTitle: entity?.title ?? "your job" });
      await queueNotification({
        userId: worker.userId, type: "TIP_RECEIVED", channels: ["EMAIL", "IN_APP"],
        title: notice.subject, body: notice.text, html: notice.html, idempotencyKey: `tip-received:${allocation.id}`,
      });
    }
  }

  const updatedTip = await prisma.tip.findUnique({ where: { id: tip.id } });
  return NextResponse.json({ tip: updatedTip, allocationIds: result.allocationIds });
}
