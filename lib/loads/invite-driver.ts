import { prisma } from "@/lib/db";
import { queueNotification } from "@/lib/notifications";
import { jobInvitationTemplate, customLoadInvitationTemplate } from "@/lib/email/templates/booking";
import { renderInvitationTemplate, type RenderedTemplate } from "@/lib/loads/invitation-template";
import type { CarrierRoute } from "@prisma/client";

const DEFAULT_EXPIRATION_HOURS = 2;

// Re-exported so existing importers of these from invite-driver keep
// working; the actual (pure, db-free) implementation lives in
// invitation-template.ts so tests can import it without Prisma.
export { renderInvitationTemplate };
export type { RenderedTemplate };

export type InviteDriverResult =
  | { ok: true; invitationId: string; workerId: string }
  | { ok: false; workerId: string; status: number; error: string };

/**
 * The single source of eligibility + upsert + notify logic for inviting
 * one driver to one load — extracted so the bulk endpoint (Phase 4)
 * enforces exactly the same rules as the original single-invite POST
 * instead of a second, drift-prone copy of them. The caller is
 * responsible for load-level checks that only need doing once (load
 * exists, caller owns it, load is open) — this function re-checks load
 * status defensively but the per-worker checks (worker exists, is a
 * driver, is active) are its actual job.
 */
export async function inviteDriverToLoad(params: {
  load: Pick<CarrierRoute, "id" | "title" | "pickupDate" | "status">;
  workerId: string;
  expirationHours?: number;
  /** RAW template (subject/body with un-substituted {tokens}) straight
   *  from the InvitationTemplate row — this function does the
   *  per-driver substitution internally, since driverName/expiresAt
   *  aren't known until here. Undefined ⇒ default invitation message. */
  template?: { subject: string; body: string };
}): Promise<InviteDriverResult> {
  const { load, workerId } = params;

  if (!["OPEN", "OFFER_RECEIVED"].includes(load.status)) {
    return { ok: false, workerId, status: 409, error: "Load is no longer open." };
  }

  const worker = await prisma.workerProfile.findUnique({ where: { id: workerId } });
  if (!worker) return { ok: false, workerId, status: 404, error: "Worker not found." };
  if (!["BOX_TRUCK_DRIVER", "SEMI_DRIVER"].includes(worker.workerType)) {
    return { ok: false, workerId, status: 400, error: "Only driver accounts can be invited to freight loads." };
  }
  if (worker.operationalStatus !== "ACTIVE") {
    return { ok: false, workerId, status: 409, error: "This worker's account is not currently active." };
  }

  const expiresAt = new Date(Date.now() + (params.expirationHours ?? DEFAULT_EXPIRATION_HOURS) * 60 * 60 * 1000);

  // upsert — re-inviting the same driver to the same load after a prior
  // invitation expired or was declined updates the existing row instead
  // of colliding with @@unique([carrierRouteId, workerId]).
  const invitation = await prisma.carrierRouteInvitation.upsert({
    where: { carrierRouteId_workerId: { carrierRouteId: load.id, workerId: worker.id } },
    update: { status: "PENDING", expiresAt, respondedAt: null },
    create: { carrierRouteId: load.id, workerId: worker.id, status: "PENDING", expiresAt },
  });

  const notice = params.template
    ? customLoadInvitationTemplate(renderInvitationTemplate(params.template, {
        driverName: worker.displayName ?? "there",
        loadTitle: load.title,
        pickupDate: load.pickupDate,
        expiresAt,
      }))
    : jobInvitationTemplate({ workerName: worker.displayName ?? "there", jobTitle: load.title, scheduledStart: load.pickupDate, expiresAt });

  await queueNotification({
    userId: worker.userId,
    type: "LOAD_INVITATION",
    channels: ["EMAIL", "IN_APP"],
    title: notice.subject,
    body: notice.text,
    html: notice.html,
    idempotencyKey: `load-invitation:${invitation.id}:${invitation.expiresAt?.toISOString()}`,
  });

  return { ok: true, invitationId: invitation.id, workerId: worker.id };
}
