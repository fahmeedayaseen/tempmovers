import { NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { reserveBonusRecoveryForPayout, releaseBonusRecoveryReservation } from "@/lib/bonus-ledger";
import { captureIntegrationAlert } from "@/lib/monitoring";
import { queueNotification } from "@/lib/notifications";
import { payoutStatusTemplate } from "@/lib/email/templates/payments";

/**
 * Pays out a worker via a real Stripe Transfer to their connected Express
 * account. Admin-only — a worker never triggers their own payout.
 *
 * Sequence, and why it's split this way:
 * 1. If PROCESSING already: reconcile first — check our own PayoutOperation
 *    record (durable, created before we ever called Stripe) before falling
 *    back to listing recent Stripe transfers as a secondary check.
 * 2. Inside a DB transaction: re-check the payout is SCHEDULED or FAILED
 *    (retryable), reserve any outstanding bonus-recovery debt against it,
 *    create the PayoutOperation record, and mark the payout PROCESSING.
 *    Atomic — no other request can interleave between the balance read and
 *    the reservation write.
 * 3. Outside the transaction: call Stripe, reusing the SAME idempotency
 *    key on a retry — Stripe's own idempotency then prevents a duplicate
 *    transfer even if our DB-side retry logic has a bug.
 * 4. On success, mark the PayoutOperation COMPLETED and the payout
 *    TRANSFERRED. On failure, release the reservation (the debt was never
 *    actually recovered), mark the PayoutOperation FAILED and the payout
 *    FAILED, and record the retry count / failure reason.
 */
export async function POST(request: Request, context: { params: Promise<{ payoutId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { payoutId } = await context.params;

  const payout = await prisma.payout.findUnique({ where: { id: payoutId }, include: { worker: true } });
  if (!payout) return NextResponse.json({ error: "Payout not found." }, { status: 404 });
  if (payout.status === "TRANSFERRED" || payout.status === "PAID_OUT") {
    return NextResponse.json({ error: "Already paid." }, { status: 409 });
  }
  if (payout.status === "OFFSET") {
    return NextResponse.json({ error: "This payout was fully offset by a bonus recovery balance — nothing to transfer." }, { status: 409 });
  }
  if (payout.status === "HELD") return NextResponse.json({ error: "This payout is on hold." }, { status: 409 });

  // Reconcile a PROCESSING payout before anything else. Check our own
  // PayoutOperation record first — created before we ever called Stripe,
  // so its idempotencyKey/status is a durable record of what we attempted,
  // not a guess. Only fall back to listing recent Stripe transfers if no
  // operation record exists at all (e.g. a payout stuck PROCESSING from
  // before this table existed).
  if (payout.status === "PROCESSING") {
    const operation = await prisma.payoutOperation.findFirst({ where: { payoutId: payout.id }, orderBy: { startedAt: "desc" } });

    if (operation?.status === "COMPLETED" && operation.stripeTransferId) {
      const reconciled = await prisma.payout.update({
        where: { id: payout.id },
        data: { stripeTransferId: operation.stripeTransferId, status: "TRANSFERRED", paidAt: new Date() },
      });
      await prisma.auditLog.create({
        data: { actorId: authed.userId, action: "PAYOUT_RECONCILED", entityType: "Payout", entityId: payout.id, details: { stripeTransferId: operation.stripeTransferId, source: "PayoutOperation" } },
      });
      return NextResponse.json({ payout: reconciled, transferred: true, reconciled: true });
    }

    if (operation) {
      // We have a durable record of the attempt (idempotency key known) but
      // it never resolved to COMPLETED — check Stripe directly by
      // idempotency key rather than scanning a transfer list.
      const transfers = await stripe.transfers.list({ limit: 100 });
      const matched = transfers.data.find((t) => t.metadata?.payoutId === payout.id);
      if (matched) {
        await prisma.payoutOperation.update({ where: { id: operation.id }, data: { status: "COMPLETED", stripeTransferId: matched.id, completedAt: new Date() } });
        const reconciled = await prisma.payout.update({
          where: { id: payout.id },
          data: { stripeTransferId: matched.id, status: "TRANSFERRED", paidAt: new Date() },
        });
        await prisma.auditLog.create({
          data: { actorId: authed.userId, action: "PAYOUT_RECONCILED", entityType: "Payout", entityId: payout.id, details: { stripeTransferId: matched.id, source: "transfer-list-fallback" } },
        });
        return NextResponse.json({ payout: reconciled, transferred: true, reconciled: true });
      }
      captureIntegrationAlert("Payout stuck PROCESSING with a known operation but no matching Stripe transfer.", { area: "payout", payoutId: payout.id, operationId: operation.id });
      return NextResponse.json({
        error: "This payout is PROCESSING with a known operation attempt but no matching Stripe transfer found. Investigate manually before retrying — do not assume it's safe to resubmit.",
      }, { status: 409 });
    }

    // No PayoutOperation record at all — pre-existing stopgap path for a
    // payout that was already PROCESSING before this table was introduced.
    const transfers = await stripe.transfers.list({ limit: 100 });
    const existingTransfer = transfers.data.find((t) => t.metadata?.payoutId === payout.id);
    if (existingTransfer) {
      const reconciled = await prisma.payout.update({
        where: { id: payout.id },
        data: { stripeTransferId: existingTransfer.id, status: "TRANSFERRED", paidAt: new Date() },
      });
      await prisma.auditLog.create({
        data: { actorId: authed.userId, action: "PAYOUT_RECONCILED", entityType: "Payout", entityId: payout.id, details: { stripeTransferId: existingTransfer.id, source: "transfer-list-legacy" } },
      });
      return NextResponse.json({ payout: reconciled, transferred: true, reconciled: true });
    }
    captureIntegrationAlert("Payout stuck PROCESSING with no PayoutOperation record and no matching transfer.", { area: "payout", payoutId: payout.id });
    return NextResponse.json({
      error: "This payout is PROCESSING with no matching Stripe transfer found in the recent history. Investigate manually before retrying — do not assume it's safe to resubmit.",
    }, { status: 409 });
  }

  if (!["SCHEDULED", "FAILED"].includes(payout.status)) {
    return NextResponse.json({ error: `Payout status ${payout.status} is not retryable.` }, { status: 409 });
  }
  if (!payout.worker.stripeAccountId || !payout.worker.stripePayoutsEnabled) {
    return NextResponse.json({ error: "Worker has not completed Stripe Connect onboarding." }, { status: 409 });
  }
  // Deliberately narrower than the full eligibility gate: the work was
  // already legitimately performed, so a subscription lapsing or
  // onboarding technically not being "COMPLETE" after the fact shouldn't
  // withhold pay for it. What must block a payout is an active compliance
  // action against the worker — suspension or closure.
  if (payout.worker.operationalStatus === "SUSPENDED" || payout.worker.operationalStatus === "CLOSED") {
    return NextResponse.json({ error: `Worker account is ${payout.worker.operationalStatus.toLowerCase()} — payout blocked pending review.` }, { status: 409 });
  }

  const isRetry = payout.status === "FAILED";
  // Stable idempotency key regardless of retry — this is what lets Stripe
  // itself refuse to create a second transfer even if this retry logic has
  // a bug.
  const idempotencyKey = `payout:${payout.id}`;

  const reservation = await prisma.$transaction(async (tx) => {
    const fresh = await tx.payout.findUniqueOrThrow({ where: { id: payout.id } });
    if (!["SCHEDULED", "FAILED"].includes(fresh.status)) {
      throw new Error("PAYOUT_NOT_RETRYABLE");
    }

    // A prior FAILED attempt already released its reservation (see the
    // catch block below), so recomputing the balance fresh here is
    // correct and won't double-count — there's nothing stale left over
    // from the failed attempt to conflict with.
    const { recoveryCents, netPayoutCents } = await reserveBonusRecoveryForPayout(tx, {
      workerId: fresh.workerId,
      grossEarningsCents: fresh.grossEarningsCents,
      payoutId: fresh.id,
    });

    if (netPayoutCents <= 0) {
      await tx.payout.update({
        where: { id: fresh.id },
        data: { status: "OFFSET", recoveryCents, netPayoutCents: 0, adjustmentsCents: -recoveryCents, paidAt: new Date() },
      });
      return { fullyOffset: true as const, recoveryCents, netPayoutCents: 0, operationId: null };
    }

    // Created BEFORE the Stripe call, inside the same transaction that
    // marks the payout PROCESSING — this is the durable record that makes
    // reconciliation above possible without relying solely on scanning
    // Stripe's transfer list. Upsert, not create: idempotencyKey is stable
    // across retries by design, so a retry updates the same operation
    // record back to PROCESSING rather than colliding with the unique
    // constraint on a second insert.
    const operation = await tx.payoutOperation.upsert({
      where: { idempotencyKey },
      update: { status: "PROCESSING", lastError: null },
      create: { payoutId: fresh.id, idempotencyKey, status: "PROCESSING" },
    });

    await tx.payout.update({
      where: { id: fresh.id },
      data: { status: "PROCESSING", recoveryCents, netPayoutCents },
    });
    return { fullyOffset: false as const, recoveryCents, netPayoutCents, operationId: operation.id };
  });

  if (reservation.fullyOffset) {
    const updated = await prisma.payout.findUniqueOrThrow({ where: { id: payout.id } });
    await prisma.auditLog.create({
      data: { actorId: authed.userId, action: "PAYOUT_OFFSET", entityType: "Payout", entityId: payout.id, details: { recoveryCents: reservation.recoveryCents } },
    });
    const offsetNotice = payoutStatusTemplate({ workerName: payout.worker.displayName ?? "there", status: "OFFSET", netPayoutCents: 0 });
    await queueNotification({
      userId: payout.worker.userId, type: "PAYOUT_STATUS", channels: ["EMAIL", "IN_APP"],
      title: offsetNotice.subject, body: offsetNotice.text, html: offsetNotice.html, idempotencyKey: `payout-offset:${payout.id}`,
    });
    return NextResponse.json({ payout: updated, transferred: false, fullyOffset: true });
  }

  let transfer;
  try {
    transfer = await stripe.transfers.create(
      {
        amount: reservation.netPayoutCents,
        currency: "usd",
        destination: payout.worker.stripeAccountId,
        metadata: { payoutId: payout.id, workerId: payout.workerId, assignmentId: payout.assignmentId },
      },
      { idempotencyKey },
    );
  } catch (error) {
    // The transfer never happened — release the reservation so the
    // recovery balance goes back to reflecting reality, mark the
    // PayoutOperation and the payout FAILED (not OFFSET or PROCESSING) so
    // both remain retryable and consistent with each other.
    await releaseBonusRecoveryReservation(payout.id);
    const failureReason = error instanceof Error ? error.message : "Stripe transfer failed";
    await prisma.$transaction([
      prisma.payoutOperation.update({ where: { id: reservation.operationId! }, data: { status: "FAILED", lastError: failureReason, completedAt: new Date() } }),
      prisma.payout.update({
        where: { id: payout.id },
        data: {
          status: "FAILED", failedAt: new Date(), failureReason,
          retryCount: { increment: isRetry ? 1 : 0 },
          recoveryCents: 0, netPayoutCents: payout.grossEarningsCents,
        },
      }),
    ]);
    await prisma.auditLog.create({
      data: { actorId: authed.userId, action: "PAYOUT_TRANSFER_FAILED", entityType: "Payout", entityId: payout.id, details: { error: failureReason, isRetry } },
    });
    const failedNotice = payoutStatusTemplate({ workerName: payout.worker.displayName ?? "there", status: "FAILED", netPayoutCents: payout.grossEarningsCents });
    await queueNotification({
      userId: payout.worker.userId, type: "PAYOUT_STATUS", channels: ["EMAIL", "IN_APP"],
      title: failedNotice.subject, body: failedNotice.text, html: failedNotice.html, idempotencyKey: `payout-failed:${payout.id}:${payout.retryCount}`,
    });
    return NextResponse.json({ error: "Stripe transfer failed — the recovery reservation was released and the payout can be retried." }, { status: 502 });
  }

  // TRANSFERRED, not PAID_OUT: this confirms movement to the worker's
  // Connect account balance, not confirmed arrival in their bank account.
  const [, updated] = await prisma.$transaction([
    prisma.payoutOperation.update({ where: { id: reservation.operationId! }, data: { status: "COMPLETED", stripeTransferId: transfer.id, completedAt: new Date() } }),
    prisma.payout.update({
      where: { id: payout.id },
      data: { stripeTransferId: transfer.id, idempotencyKey, status: "TRANSFERRED", paidAt: new Date() },
    }),
  ]);

  await prisma.auditLog.create({
    data: { actorId: authed.userId, action: "PAYOUT_TRANSFERRED", entityType: "Payout", entityId: payout.id, details: { stripeTransferId: transfer.id, netPayoutCents: reservation.netPayoutCents, recoveryCents: reservation.recoveryCents, wasRetry: isRetry } },
  });

  const transferredNotice = payoutStatusTemplate({ workerName: payout.worker.displayName ?? "there", status: "TRANSFERRED", netPayoutCents: reservation.netPayoutCents });
  await queueNotification({
    userId: payout.worker.userId, type: "PAYOUT_STATUS", channels: ["EMAIL", "IN_APP"],
    title: transferredNotice.subject, body: transferredNotice.text, html: transferredNotice.html, idempotencyKey: `payout-transferred:${payout.id}`,
  });

  return NextResponse.json({ payout: updated, transferred: true, fullyOffset: false });
}
