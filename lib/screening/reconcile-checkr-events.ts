import { prisma } from "@/lib/db";
import { syncWorkerComplianceTracks } from "@/lib/compliance/sync-tracks";

/**
 * Retries events the webhook couldn't match to a BackgroundCheck at the
 * time they arrived — an ordering race (Checkr's webhook beating our own
 * write of the BackgroundCheck row) rather than a genuinely invalid event.
 * Call from a protected cron/admin route on a schedule; each call takes a
 * bounded batch so this can't itself run unbounded on a bad backlog.
 */
export async function reconcilePendingCheckrEvents(limit = 50) {
  const events = await prisma.processedCheckrEvent.findMany({
    where: { status: "PENDING_RECONCILIATION" },
    orderBy: { receivedAt: "asc" },
    take: limit,
  });

  let reconciled = 0;
  let stillPending = 0;
  let failed = 0;

  for (const event of events) {
    try {
      const backgroundCheck = await prisma.backgroundCheck.findFirst({
        where: {
          OR: [
            ...(event.candidateId ? [{ candidateId: event.candidateId }] : []),
            ...(event.reportId ? [{ reportId: event.reportId }] : []),
            ...(event.invitationId ? [{ invitationId: event.invitationId }] : []),
          ],
        },
      });

      if (!backgroundCheck) {
        stillPending += 1;
        await prisma.processedCheckrEvent.update({
          where: { id: event.id },
          data: { attemptCount: { increment: 1 }, lastAttemptAt: new Date() },
        });
        continue;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawEvent = event.rawPayload as any;
      const object = rawEvent?.data?.object ?? {};

      await prisma.$transaction(async (tx) => {
        await tx.backgroundCheck.update({
          where: { id: backgroundCheck.id },
          data: {
            candidateId: event.candidateId ?? backgroundCheck.candidateId,
            reportId: event.reportId ?? backgroundCheck.reportId,
            status: object.status ?? backgroundCheck.status,
            result: object.result ?? backgroundCheck.result,
            completedAt: object.status === "complete" || rawEvent?.type === "report.completed" ? new Date() : backgroundCheck.completedAt,
            rawResponse: rawEvent,
          },
        });

        await tx.processedCheckrEvent.update({
          where: { id: event.id },
          data: { status: "PROCESSED", processedAt: new Date(), reconciledAt: new Date(), lastError: null },
        });

        await tx.auditLog.create({
          data: {
            action: "CHECKR_EVENT_RECONCILED", entityType: "BackgroundCheck", entityId: backgroundCheck.id,
            details: { eventId: event.id, eventType: event.eventType },
          },
        });
      });

      await syncWorkerComplianceTracks(prisma, backgroundCheck.workerId);
      reconciled += 1;
    } catch (error) {
      failed += 1;
      await prisma.processedCheckrEvent.update({
        where: { id: event.id },
        data: {
          attemptCount: { increment: 1 }, lastAttemptAt: new Date(),
          lastError: error instanceof Error ? error.message : "Unknown reconciliation error",
        },
      });
    }
  }

  return { checked: events.length, reconciled, stillPending, failed };
}
