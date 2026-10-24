import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

/**
 * Every generator here follows the same shape: look up the BonusProgram by
 * its seeded code, check the qualifying condition, then attempt to create
 * exactly one BonusAward keyed by (programId, qualifyingEntityId). The
 * unique constraint on BonusAward — not an application-level "does one
 * already exist" check — is what actually guarantees idempotency under
 * retries and webhook redelivery; the try/catch below treats ONLY that
 * specific constraint violation (Prisma error P2002) as an expected no-op.
 * Any other error (bad foreign key, connection failure, a real bug) is
 * rethrown — a bare catch-all here would silently hide exactly those
 * failures as if they were harmless duplicate-award conflicts.
 *
 * All generators accept an optional Prisma transaction client so they can
 * run inside the same transaction as the payment-capture write that
 * triggers them — a generator succeeding while the capture itself rolls
 * back (or vice versa) would be a real inconsistency.
 */

type Client = Prisma.TransactionClient | typeof prisma;

async function getProgram(client: Client, code: string) {
  const program = await client.bonusProgram.findUnique({ where: { code } });
  if (!program || !program.active) return null;
  return program;
}

async function tryCreateAward(client: Client, {
  programId, qualifyingEntityId, amountCents, reason, userId, workerId, partnerOrganizationId,
}: {
  programId: string; qualifyingEntityId: string; amountCents: number; reason: string;
  userId?: string; workerId?: string; partnerOrganizationId?: string;
}) {
  try {
    return await client.bonusAward.create({
      data: {
        programId, qualifyingEntityId, amountCents, reason,
        status: "PENDING", earnedAt: new Date(),
        userId, workerId, partnerOrganizationId,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      // Unique(programId, qualifyingEntityId) conflict — this exact award
      // was already generated (retry, webhook redelivery, or a second
      // capture attempt). Expected, not an error.
      return null;
    }
    throw error;
  }
}

/** Customer's first completed, paid, non-refunded moving job. */
export async function generateCustomerFirstBookingCredit(client: Client, job: { id: string; customerId: string; status: string }) {
  if (job.status !== "COMPLETED") return null;
  const program = await getProgram(client, "CUSTOMER_FIRST_BOOKING_25");
  if (!program) return null;

  const customer = await client.customerProfile.findUnique({ where: { id: job.customerId }, select: { userId: true } });
  if (!customer) return null;

  // "First" is enforced by checking no prior award from this program for
  // this user exists yet — qualifyingEntityId (this job's ID) makes the
  // specific award idempotent, this check is what makes it specifically
  // the FIRST one rather than one-per-job.
  const alreadyHasOne = await client.bonusAward.findFirst({ where: { programId: program.id, userId: customer.userId } });
  if (alreadyHasOne) return null;

  return tryCreateAward(client, {
    programId: program.id, qualifyingEntityId: job.id, amountCents: program.amountCents,
    reason: `First completed and paid booking (job ${job.id})`, userId: customer.userId,
  });
}

/** Mover's first completed, paid, non-refunded job. */
export async function generateMoverFirstJobBonus(client: Client, job: { id: string; status: string }, workerId: string) {
  if (job.status !== "COMPLETED") return null;
  const program = await getProgram(client, "MOVER_FIRST_JOB_25");
  if (!program) return null;

  const alreadyHasOne = await client.bonusAward.findFirst({ where: { programId: program.id, workerId } });
  if (alreadyHasOne) return null;

  return tryCreateAward(client, {
    programId: program.id, qualifyingEntityId: `${job.id}:${workerId}`, amountCents: program.amountCents,
    reason: `First completed and paid job (job ${job.id})`, workerId,
  });
}

/** Three 5-star ratings on completed, paid jobs. Re-checked after every new review, not just at job completion — a review can land after payment already captured. */
export async function generateThreeFiveStarBonus(client: Client, workerId: string) {
  const program = await getProgram(client, "THREE_5STAR_25");
  if (!program) return null;

  const alreadyHasOne = await client.bonusAward.findFirst({ where: { programId: program.id, workerId } });
  if (alreadyHasOne) return null;

  // Only PUBLISHED ratings tied to a job that actually completed AND was
  // paid count — a HIDDEN/REMOVED review, or one on a job that was never
  // captured (or was refunded), shouldn't count toward this. distinct on
  // jobId is redundant with @@unique([jobId, workerId]) but documents the
  // intent explicitly: this counts distinct qualifying jobs, not review rows.
  const fiveStarPaidReviews = await client.review.findMany({
    where: { workerId, rating: 5, status: "PUBLISHED", job: { status: "COMPLETED", paymentStatus: "CAPTURED" } },
    select: { id: true, jobId: true },
    distinct: ["jobId"],
    take: program.qualificationCount,
  });
  if (fiveStarPaidReviews.length < program.qualificationCount) return null;

  return tryCreateAward(client, {
    programId: program.id, qualifyingEntityId: workerId, amountCents: program.amountCents,
    reason: `${program.qualificationCount} five-star paid jobs reached`, workerId,
  });
}

/** A referred mover's Nth qualifying completed+paid job triggers the REFERRER's bonus. */
export async function generateMoverReferralBonus(client: Client, referredWorkerId: string) {
  const program = await getProgram(client, "MOVER_REFERRAL_50");
  if (!program) return null;

  const referred = await client.workerProfile.findUnique({ where: { id: referredWorkerId }, select: { referredByWorkerId: true, completedJobs: true } });
  if (!referred?.referredByWorkerId) return null;
  if (referred.completedJobs < program.qualificationCount) return null;

  const alreadyHasOne = await client.bonusAward.findFirst({ where: { programId: program.id, workerId: referred.referredByWorkerId, qualifyingEntityId: referredWorkerId } });
  if (alreadyHasOne) return null;

  return tryCreateAward(client, {
    programId: program.id, qualifyingEntityId: referredWorkerId, amountCents: program.amountCents,
    reason: `Referred mover reached ${program.qualificationCount} completed jobs`, workerId: referred.referredByWorkerId,
  });
}

/** A referred driver's Nth qualifying completed+paid route triggers the REFERRER's bonus. */
export async function generateDriverReferralBonus(client: Client, referredWorkerId: string) {
  const program = await getProgram(client, "DRIVER_REFERRAL_75");
  if (!program) return null;

  const referred = await client.workerProfile.findUnique({ where: { id: referredWorkerId }, select: { referredByWorkerId: true, completedJobs: true } });
  if (!referred?.referredByWorkerId) return null;
  if (referred.completedJobs < program.qualificationCount) return null;

  const alreadyHasOne = await client.bonusAward.findFirst({ where: { programId: program.id, workerId: referred.referredByWorkerId, qualifyingEntityId: referredWorkerId } });
  if (alreadyHasOne) return null;

  return tryCreateAward(client, {
    programId: program.id, qualifyingEntityId: referredWorkerId, amountCents: program.amountCents,
    reason: `Referred driver reached ${program.qualificationCount} completed routes`, workerId: referred.referredByWorkerId,
  });
}

/** Referred customer's first completed, paid, non-refunded job/load — credits the referring partner. */
export async function generatePartnerReferralCredit(client: Client, job: { id: string; customerId: string; status: string }) {
  if (job.status !== "COMPLETED") return null;
  const program = await getProgram(client, "PARTNER_REFERRAL_25");
  if (!program) return null;

  const customer = await client.customerProfile.findUnique({ where: { id: job.customerId }, select: { userId: true, user: { select: { email: true } } } });
  if (!customer) return null;

  const referral = await client.referralEvent.findFirst({
    where: { referredEmail: customer.user.email, partnerId: { not: null }, qualifiedAt: null },
    orderBy: { createdAt: "asc" },
  });
  if (!referral || !referral.partnerId) return null;

  const alreadyHasOne = await client.bonusAward.findFirst({ where: { programId: program.id, partnerOrganizationId: referral.partnerId, qualifyingEntityId: referral.id } });
  if (alreadyHasOne) return null;

  const award = await tryCreateAward(client, {
    programId: program.id, qualifyingEntityId: referral.id, amountCents: program.amountCents,
    reason: `Referred customer completed a qualifying job (${job.id})`, partnerOrganizationId: referral.partnerId,
  });
  if (award) {
    await client.referralEvent.update({ where: { id: referral.id }, data: { qualifiedAt: new Date(), completedJobId: job.id, rewardCents: program.amountCents } });
  }
  return award;
}

/**
 * Runs every job-completion-triggered generator for a single job. Call this
 * from wherever a job's payment is captured (the actual "completed, paid,
 * non-refunded" moment) — not at job completion alone, which is why this
 * takes the job's current status/customerId and the list of workers whose
 * work on it was approved and paid.
 */
export async function runJobCompletionBonusGenerators(client: Client, job: { id: string; customerId: string; status: string }, paidWorkerIds: string[]) {
  await generateCustomerFirstBookingCredit(client, job);
  await generatePartnerReferralCredit(client, job);
  for (const workerId of paidWorkerIds) {
    await generateMoverFirstJobBonus(client, job, workerId);
    await generateThreeFiveStarBonus(client, workerId);
    await generateMoverReferralBonus(client, workerId);
  }
}
