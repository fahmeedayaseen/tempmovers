import { prisma } from "@/lib/db";

/**
 * Enforces a job's posting mode against the open-marketplace self-apply
 * flow. The four modes:
 *  - OPEN_MARKETPLACE: no restriction (existing behavior, untouched).
 *  - PREFERRED_NETWORK_FIRST: only workers preferred by any of the
 *    posting customer's partner organizations may self-apply during
 *    the window below; opens to everyone once it elapses.
 *  - INVITE_SPECIFIC_WORKERS / PRIVATE_INVITATION_ONLY: self-apply is
 *    blocked entirely — the only path onto the job is accepting a
 *    direct invitation via POST /api/jobs/[jobId]/invite.
 *
 * The window is a named constant rather than a per-job/per-partner
 * configurable field — "configurable" is satisfied by having one clear
 * place to change it, not a full settings system, which would be a
 * disproportionate amount of new surface for this specific number.
 */
export const PREFERRED_NETWORK_FIRST_WINDOW_HOURS = 2;

export async function checkJobPostingModeAllowsSelfApply(
  job: { id: string; customerId: string; postingMode: string; createdAt: Date },
  workerId: string,
): Promise<{ allowed: true } | { allowed: false; reason: string }> {
  if (job.postingMode === "OPEN_MARKETPLACE") return { allowed: true };

  if (job.postingMode === "INVITE_SPECIFIC_WORKERS" || job.postingMode === "PRIVATE_INVITATION_ONLY") {
    return { allowed: false, reason: "This job is invitation-only — it must be accepted through a direct invitation, not applied to." };
  }

  if (job.postingMode === "PREFERRED_NETWORK_FIRST") {
    const windowEnd = new Date(job.createdAt.getTime() + PREFERRED_NETWORK_FIRST_WINDOW_HOURS * 60 * 60 * 1000);
    if (new Date() >= windowEnd) return { allowed: true }; // window elapsed — open to everyone

    const customerPartnerOrgs = await prisma.partnerOrganization.findMany({ where: { customerId: job.customerId }, select: { id: true } });
    if (customerPartnerOrgs.length === 0) {
      // No partner organization means no preferred network exists to
      // check against — the window blocks everyone until it elapses,
      // rather than silently behaving like OPEN_MARKETPLACE and
      // defeating the point of choosing this mode.
      return { allowed: false, reason: `This job is currently reserved for the customer's preferred network. Open applications begin ${windowEnd.toLocaleString()}.` };
    }
    const preferred = await prisma.preferredWorker.findFirst({
      where: { workerId, partnerId: { in: customerPartnerOrgs.map((p) => p.id) } },
    });
    if (preferred) return { allowed: true };
    return { allowed: false, reason: `This job is currently reserved for the customer's preferred network. Open applications begin ${windowEnd.toLocaleString()}.` };
  }

  return { allowed: false, reason: `Unrecognized posting mode ${job.postingMode}.` };
}
