import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";

/**
 * Called when a job/load's payment is refunded or a chargeback is lost.
 * Behavior depends on the bonus award's current status:
 *
 * - PENDING or APPROVED (not yet paid): void it. Nothing was ever disbursed,
 *   so there's nothing to reverse — the award simply never happened.
 * - PAID: leave the award's own status as PAID (financial history is never
 *   rewritten) and add a negative RECOVERY ledger entry instead. The
 *   recipient's payable balance going forward should net this against
 *   future payouts, not against the past record of what was already paid.
 *
 * Idempotent per (bonus award, Stripe event): the
 * unique(bonusAwardId, stripeEventId, type) constraint on BonusLedgerEntry
 * means calling this twice for the same refund/dispute event is a no-op
 * per award, matching the same replay-safety pattern as the webhook's
 * ProcessedStripeEvent check — and correctly allows one event to recover
 * multiple different awards it affected, instead of only the first one.
 */
export async function recoverBonusesForQualifyingEntity({
  qualifyingEntityId,
  reason,
  stripeEventId,
  relatedJobId,
  relatedRouteId,
}: {
  qualifyingEntityId: string;
  reason: string;
  stripeEventId: string;
  relatedJobId?: string;
  relatedRouteId?: string;
}) {
  const awards = await prisma.bonusAward.findMany({
    where: { qualifyingEntityId },
  });

  for (const award of awards) {
    if (award.status === "PENDING" || award.status === "EARNED" || award.status === "APPROVED") {
      await prisma.bonusAward.update({
        where: { id: award.id },
        data: { status: "VOIDED", denialReason: reason },
      });
      continue;
    }

    if (award.status === "PAID") {
      try {
        await prisma.bonusLedgerEntry.create({
          data: {
            bonusAwardId: award.id,
            type: "RECOVERY",
            amountCents: -Math.abs(award.amountCents),
            reason,
            relatedJobId,
            relatedRouteId,
            stripeEventId,
          },
        });
      } catch {
        // Unique(bonusAwardId, stripeEventId, type) conflict — this event
        // was already processed for this specific award. Expected on
        // webhook redelivery, not an error.
      }
    }
  }
}

/**
 * A worker's net bonus recovery balance — negative means they owe TempMovers
 * money back from a prior refund/chargeback on a bonus that already paid
 * out. Summing the whole ledger (AWARD + PAYMENT + RECOVERY + ADJUSTMENT)
 * is deliberate: it's the actual running balance, not just outstanding
 * RECOVERY entries, so an ADJUSTMENT entry created when a balance is
 * applied to a payout (see reserveBonusRecoveryForPayout below) correctly
 * zeroes it back out instead of double-counting.
 */
export async function getWorkerBonusRecoveryBalance(workerId: string): Promise<number> {
  const result = await prisma.bonusLedgerEntry.aggregate({
    where: { bonusAward: { workerId } },
    _sum: { amountCents: true },
  });
  return result._sum.amountCents ?? 0;
}

/**
 * Transaction-scoped variant of getWorkerBonusRecoveryBalance — takes a
 * Prisma transaction client instead of the global client so the balance
 * read and the reservation write happen atomically. Reading the balance
 * outside the transaction (the old approach) left a window where two
 * concurrent payout attempts could both read the same balance and both
 * apply a recovery against it.
 */
async function getWorkerBonusRecoveryBalanceTx(tx: Prisma.TransactionClient, workerId: string): Promise<number> {
  const result = await tx.bonusLedgerEntry.aggregate({
    where: { bonusAward: { workerId } },
    _sum: { amountCents: true },
  });
  return result._sum.amountCents ?? 0;
}

/**
 * Reserves (does not transfer) an outstanding negative bonus balance
 * against a payout, inside an existing transaction. Must be called from
 * within a `prisma.$transaction()` alongside the payout status update — see
 * app/api/payouts/[payoutId]/pay/route.ts for the full atomic sequence:
 * check payout is SCHEDULED -> read balance -> reserve as ADJUSTMENT ->
 * mark PROCESSING -> only THEN call Stripe. If the Stripe transfer fails
 * after this, the caller is responsible for releasing the reservation
 * (see releaseBonusRecoveryReservation below) — never silently clearing a
 * recovery balance for a transfer that didn't happen.
 *
 * Allocates against the award that actually carries the outstanding
 * negative balance, not an arbitrary "most recent award" — the previous
 * version could tag a completely unrelated, zero-debt award as the
 * recovery source.
 */
export async function reserveBonusRecoveryForPayout(
  tx: Prisma.TransactionClient,
  { workerId, grossEarningsCents, payoutId }: { workerId: string; grossEarningsCents: number; payoutId: string },
): Promise<{ recoveryCents: number; netPayoutCents: number }> {
  const balance = await getWorkerBonusRecoveryBalanceTx(tx, workerId);
  const outstandingDebt = Math.abs(Math.min(0, balance));
  const recoveryCents = Math.min(grossEarningsCents, outstandingDebt);

  if (recoveryCents > 0) {
    // Per-award balances, not the worker's total — find one that's
    // actually negative to attribute the recovery to.
    const awards = await tx.bonusAward.findMany({ where: { workerId }, select: { id: true } });
    let sourceAwardId: string | null = null;
    for (const award of awards) {
      const awardBalance = await tx.bonusLedgerEntry.aggregate({
        where: { bonusAwardId: award.id },
        _sum: { amountCents: true },
      });
      if ((awardBalance._sum.amountCents ?? 0) < 0) {
        sourceAwardId = award.id;
        break;
      }
    }

    if (sourceAwardId) {
      try {
        await tx.bonusLedgerEntry.create({
          data: {
            bonusAwardId: sourceAwardId,
            payoutId,
            type: "ADJUSTMENT",
            amountCents: recoveryCents,
            reason: `Recovery reserved for payout ${payoutId}`,
          },
        });
      } catch {
        // Unique(payoutId, type) conflict — this payout already has a
        // reservation (a retry of this same attempt). Not an error; the
        // existing reservation is what should stand.
      }
    }
  }

  return { recoveryCents, netPayoutCents: grossEarningsCents - recoveryCents };
}

/**
 * Releases a reservation if the Stripe transfer that was supposed to
 * follow it never happened (e.g. the transfer call itself failed). Removes
 * the ADJUSTMENT entry so the balance goes back to reflecting reality —
 * the debt was never actually recovered, so it shouldn't look recovered.
 */
export async function releaseBonusRecoveryReservation(payoutId: string) {
  await prisma.bonusLedgerEntry.deleteMany({ where: { payoutId, type: "ADJUSTMENT" } });
}
