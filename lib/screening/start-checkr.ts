import { prisma } from "@/lib/db";
import { createCheckrCandidate, createCheckrInvitation, CheckrNotConfiguredError } from "@/lib/checkr";
import { captureIntegrationAlert } from "@/lib/monitoring";

/**
 * Launches Checkr screening for a PAID charge: reuses the worker's most
 * recent Checkr candidate_id if one exists (so a returning worker doesn't
 * get a duplicate Candidate record for a second/later screening), or
 * creates one, then creates the Invitation against that candidate_id —
 * following Checkr's documented Candidate -> Invitation sequence, not the
 * old direct candidate_email-only invitation call.
 *
 * Idempotent: a charge that already has a linked BackgroundCheck is a
 * no-op, so a webhook redelivery or a manual retry can safely call this
 * again without ordering a second screening or double-charging anything.
 *
 * Called from the webhook's checkout.session.completed handler for
 * SCREENING_CHARGE sessions, and from the admin sponsorship action — same
 * function, so a sponsored applicant goes through the identical Checkr
 * flow a paid one does, just without a Stripe charge behind it.
 */
export async function startCheckrScreening(screeningChargeId: string) {
  const charge = await prisma.screeningCharge.findUnique({
    where: { id: screeningChargeId },
    include: {
      worker: {
        include: {
          user: true,
          primaryMarket: true,
          backgroundChecks: {
            where: { provider: "CHECKR", candidateId: { not: "" } },
            orderBy: { createdAt: "desc" },
            take: 1,
            select: { candidateId: true },
          },
        },
      },
      backgroundCheck: true,
    },
  });

  if (!charge) return;
  if (charge.status !== "PAID" || charge.backgroundCheck) return;

  try {
    const existingCandidateId = charge.worker.backgroundChecks[0]?.candidateId ?? null;

    const candidateId = existingCandidateId ?? (
      await createCheckrCandidate({ email: charge.worker.user.email, workerId: charge.workerId })
    ).id;

    const invitation = await createCheckrInvitation({
      candidateId,
      packageSlug: charge.packageSlug,
      screeningChargeId: charge.id,
      workLocation: {
        city: charge.worker.primaryMarket?.name ?? "Indianapolis",
        state: charge.worker.primaryMarket?.state ?? "IN",
        country: "US",
      },
    });

    await prisma.$transaction(async (tx) => {
      const backgroundCheck = await tx.backgroundCheck.create({
        data: {
          workerId: charge.workerId,
          provider: "CHECKR",
          candidateId: invitation.candidate_id,
          invitationId: invitation.id,
          invitationUrl: invitation.invitation_url ?? null,
          reportId: invitation.report_id ?? null,
          packageSlug: charge.packageSlug,
          status: invitation.status ?? "pending",
          rawResponse: invitation,
        },
      });

      await tx.screeningCharge.update({
        where: { id: charge.id },
        data: { backgroundCheckId: backgroundCheck.id, status: "SCREENING_ORDERED", screeningOrderedAt: new Date() },
      });

      await tx.workerCompliance.upsert({
        where: { workerId: charge.workerId },
        update: { backgroundStatus: "IN_PROGRESS" },
        create: { workerId: charge.workerId, backgroundStatus: "IN_PROGRESS" },
      });

      await tx.auditLog.create({
        data: {
          action: "CHECKR_INVITATION_CREATED",
          entityType: "BackgroundCheck",
          entityId: backgroundCheck.id,
          details: { candidateId: invitation.candidate_id, invitationId: invitation.id, packageSlug: charge.packageSlug },
        },
      });
    });
  } catch (error) {
    // Payment already succeeded — this failure must not look like the
    // charge itself failed. Leave status PAID (not FAILED), alert, and
    // let it be retried (the idempotency check above makes a retry safe).
    const reason = error instanceof CheckrNotConfiguredError ? error.message : error instanceof Error ? error.message : "Unknown Checkr error";
    captureIntegrationAlert("Screening payment succeeded but Checkr invitation failed.", {
      area: "checkr", screeningChargeId, error: reason,
    });
  }
}
