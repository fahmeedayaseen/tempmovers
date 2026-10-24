import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

/**
 * Atomically claims the next PaymentAttempt row for a job or load —
 * fixes a V25 audit finding: the previous approach computed
 * count()+1 and used it directly, so two near-simultaneous requests
 * could read the same count and both try to use the same attempt
 * number. The @@unique([jobId, attemptNumber]) / @@unique([loadId,
 * attemptNumber]) constraint is what makes this genuinely atomic: only
 * one concurrent create() for a given attempt number can ever succeed,
 * and this retries with the next number on a P2002 conflict rather than
 * assuming its own count was still valid by the time it tried to insert.
 *
 * The claimed row exists (operationStatus: PROCESSING) BEFORE the Stripe
 * call is ever made — callers should update this same row with the
 * result afterward (see markAttemptCreated/markAttemptFailed).
 */
export async function claimNextPaymentAttempt(
  owner: { jobId: string } | { loadId: string },
  keyPrefix: "job-payment-intent" | "load-payment-intent",
) {
  const ownerId = "jobId" in owner ? owner.jobId : owner.loadId;
  let attemptNumber = (await prisma.paymentAttempt.count({ where: owner })) + 1;

  for (let tries = 0; tries < 5; tries++) {
    const idempotencyKey = `${keyPrefix}:${ownerId}:${attemptNumber}`;
    try {
      return await prisma.paymentAttempt.create({
        data: { ...owner, attemptNumber, idempotencyKey, operationStatus: "PROCESSING" },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        attemptNumber += 1;
        continue;
      }
      throw error;
    }
  }
  throw new Error("Could not claim a payment attempt after multiple tries — unexpectedly high contention.");
}

type MappablePaymentStatus = "REQUIRES_PAYMENT_METHOD" | "PROCESSING" | "AUTHORIZED" | "CAPTURED" | "CANCELED";

/** Call after Stripe successfully returns a PaymentIntent for a claimed attempt. */
export async function markAttemptCreated(attemptId: string, stripePaymentIntentId: string, paymentStatus: MappablePaymentStatus) {
  await prisma.paymentAttempt.update({
    where: { id: attemptId },
    data: { stripePaymentIntentId, operationStatus: "CREATED", paymentStatus },
  });
}

/** Call if the Stripe call itself throws — keeps the row for audit and
 *  safe retry decisions rather than deleting it or leaving it stuck
 *  PROCESSING with no explanation. */
export async function markAttemptFailed(attemptId: string, failureReason: string) {
  await prisma.paymentAttempt.update({
    where: { id: attemptId },
    data: { operationStatus: "FAILED", failureReason },
  });
}
