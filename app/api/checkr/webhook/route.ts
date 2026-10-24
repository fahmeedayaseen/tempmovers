import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { prisma } from "@/lib/db";
import { captureIntegrationAlert } from "@/lib/monitoring";
import { syncWorkerComplianceTracks } from "@/lib/compliance/sync-tracks";

/**
 * Records Checkr candidate/invitation/report status updates. Deliberately
 * does NOT automatically restrict or reject a worker based on a
 * "consider" result — per the handoff's explicit caution, adverse action
 * based on a background check has real FCRA requirements (pre-adverse
 * notice, a waiting period, an adverse-action notice, and a dispute
 * process) that need counsel review and a real workflow, not an automated
 * webhook handler making the call. This persists the result and flags a
 * "consider" outcome for admin review — the actual restriction decision
 * stays a manual admin action.
 *
 * Hardened further from the previous version: event-ID tracking now
 * distinguishes PENDING_RECONCILIATION from PROCESSED — an event that
 * arrives before its BackgroundCheck exists (a webhook ordering race) is
 * no longer permanently discarded as a handled duplicate; it's retried by
 * a later reconciliation pass (see lib/screening/reconcile-checkr-events.ts).
 * Only a genuinely PROCESSED event is now treated as a true duplicate.
 * Reconciliation is by candidateId, reportId, OR invitationId — not just
 * candidateId, which meant an invitation-object webhook (no candidate_id
 * field) previously matched nothing.
 */
function verifySignature(payload: string, signature: string, secret: string) {
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  const suppliedBuffer = Buffer.from(signature, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return suppliedBuffer.length === expectedBuffer.length && timingSafeEqual(suppliedBuffer, expectedBuffer);
}

export async function POST(request: Request) {
  const secret = process.env.CHECKR_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "Webhook not configured." }, { status: 500 });
  }

  const payload = await request.text();
  const signature = request.headers.get("x-checkr-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing signature." }, { status: 400 });
  }
  if (!verifySignature(payload, signature, secret)) {
    return NextResponse.json({ error: "Invalid signature." }, { status: 400 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let event: any;
  try {
    event = JSON.parse(payload);
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  if (!event?.id || !event?.type) {
    return NextResponse.json({ error: "Invalid Checkr event." }, { status: 400 });
  }

  const existingEvent = await prisma.processedCheckrEvent.findUnique({ where: { id: event.id } });

  if (existingEvent?.status === "PROCESSED") {
    return NextResponse.json({ received: true, duplicate: true });
  }

  const object = event.data?.object ?? {};
  const candidateId = object.candidate_id ?? null;
  const reportId = object.object === "report" ? object.id : object.report_id ?? null;
  const invitationId = object.object === "invitation" ? object.id : null;

  // A pending unmatched event may be retried and reconciled — track the
  // attempt either way rather than silently re-processing from scratch.
  if (existingEvent) {
    await prisma.processedCheckrEvent.update({
      where: { id: event.id },
      data: { attemptCount: { increment: 1 }, lastAttemptAt: new Date(), rawPayload: event },
    });
  } else {
    await prisma.processedCheckrEvent.create({
      data: {
        id: event.id, eventType: event.type, candidateId, reportId, invitationId,
        status: "PENDING_RECONCILIATION", rawPayload: event, attemptCount: 1, lastAttemptAt: new Date(),
      },
    });
  }

  const backgroundCheck = await prisma.backgroundCheck.findFirst({
    where: {
      OR: [
        ...(candidateId ? [{ candidateId }] : []),
        ...(reportId ? [{ reportId }] : []),
        ...(invitationId ? [{ invitationId }] : []),
      ],
    },
  });

  if (!backgroundCheck) {
    // Left as PENDING_RECONCILIATION, not marked processed — a
    // BackgroundCheck row that doesn't exist yet (webhook ordering race)
    // can still be matched by a later reconciliation pass instead of being
    // permanently discarded as if this event were a handled duplicate.
    captureIntegrationAlert("Checkr webhook is pending reconciliation.", {
      area: "checkr", eventId: event.id, eventType: event.type, candidateId, reportId,
    });
    // Return 200 so Checkr doesn't continuously redeliver, while an internal
    // reconciliation job retries the association using stored identifiers.
    return NextResponse.json({ received: true, unmatched: true, pending: true });
  }

  await prisma.$transaction(async (tx) => {
    await tx.backgroundCheck.update({
      where: { id: backgroundCheck.id },
      data: {
        candidateId: candidateId ?? backgroundCheck.candidateId,
        reportId: reportId ?? backgroundCheck.reportId,
        status: object.status ?? backgroundCheck.status,
        result: object.result ?? backgroundCheck.result,
        completedAt: object.status === "complete" || event.type === "report.completed" ? new Date() : backgroundCheck.completedAt,
        rawResponse: event,
      },
    });

    await tx.processedCheckrEvent.upsert({
      where: { id: event.id },
      update: {
        status: "PROCESSED", processedAt: new Date(), reconciledAt: new Date(),
        candidateId, reportId, invitationId: invitationId ?? undefined, rawPayload: event, lastError: null,
      },
      create: {
        id: event.id, eventType: event.type, candidateId, reportId, invitationId,
        status: "PROCESSED", rawPayload: event, processedAt: new Date(), reconciledAt: new Date(),
        attemptCount: 1, lastAttemptAt: new Date(),
      },
    });

    await tx.auditLog.create({
      data: {
        action: "CHECKR_WEBHOOK_PROCESSED",
        entityType: "BackgroundCheck",
        entityId: backgroundCheck.id,
        details: { eventId: event.id, eventType: event.type, status: object.status ?? null, result: object.result ?? null },
      },
    });
  });

  if (object.result === "consider") {
    captureIntegrationAlert(
      "Checkr report requires admin review; complete the approved adverse-action workflow before restricting the worker.",
      { area: "checkr", workerId: backgroundCheck.workerId, reportId },
    );
  }

  await syncWorkerComplianceTracks(prisma, backgroundCheck.workerId);
  return NextResponse.json({ received: true });
}
