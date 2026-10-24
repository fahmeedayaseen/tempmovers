import { prisma } from "@/lib/db";
import { sendTransactionalEmail } from "@/lib/email/resend";
import { sendSms } from "@/lib/twilio";
import { captureIntegrationAlert } from "@/lib/monitoring";

export type NotificationChannel = "EMAIL" | "SMS" | "IN_APP";

export type NotificationRequest = {
  userId: string;
  type: string;
  channels: NotificationChannel[];
  title: string;
  body: string;
  html?: string;
  data?: Record<string, unknown>;
  /** Stable across retries for the SAME logical notification — e.g.
   *  `booking-confirmed:${jobId}`. This is what makes queueNotification
   *  safe to call more than once for the same event without double-sending. */
  idempotencyKey: string;
};

/**
 * Queues (and immediately attempts) delivery across every requested
 * channel. Each channel gets its OWN Notification row — a failed SMS must
 * never block the email from being recorded/sent, and vice versa — so the
 * idempotency key is suffixed per channel internally while the caller only
 * ever provides one logical key per event.
 *
 * Never throws on a delivery failure: callers (payment capture, booking
 * confirmation, etc.) must not have their own success/failure tied to
 * whether an email happened to send. Failures are persisted on the
 * Notification row for support/Sentry visibility instead.
 */
export async function queueNotification(request: NotificationRequest): Promise<void> {
  try {
    await queueNotificationInner(request);
  } catch (error) {
    // The docstring promises this function never throws — this outer catch
    // is what actually makes that true for failures before or between
    // per-channel attempts (e.g. the initial user lookup below), not just
    // failures during an individual send.
    captureIntegrationAlert("queueNotification failed outside its per-channel handling.", {
      area: "resend", userId: request.userId, type: request.type, error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function queueNotificationInner(request: NotificationRequest): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: request.userId },
    select: { email: true, phone: true, phoneVerifiedAt: true, smsOptOutAt: true, emailSuppressedAt: true },
  });
  if (!user) return;

  for (const channel of request.channels) {
    const idempotencyKey = `${request.idempotencyKey}:${channel}`;

    // Respect suppression/opt-out BEFORE creating a QUEUED row for a
    // channel we're not going to attempt — the row still gets created, as
    // SUPPRESSED, so there's a durable record of "we didn't send this and
    // why," not silence.
    if (channel === "EMAIL" && user.emailSuppressedAt) {
      await recordSuppressed(request, channel, idempotencyKey, user.email, "Email address is suppressed (prior bounce/complaint).");
      continue;
    }
    if (channel === "SMS" && (user.smsOptOutAt || !user.phoneVerifiedAt || !user.phone)) {
      await recordSuppressed(request, channel, idempotencyKey, user.phone ?? "", user.smsOptOutAt ? "User opted out of SMS." : "Phone not verified.");
      continue;
    }

    let notification;
    try {
      notification = await prisma.notification.create({
        data: {
          userId: request.userId, type: request.type, channel, title: request.title, body: request.body,
          data: request.data as never, idempotencyKey, status: "QUEUED",
        },
      });
    } catch {
      // Unique(idempotencyKey) conflict — this exact notification was
      // already queued (retry of the same event). Expected, not an error.
      continue;
    }

    try {
      if (channel === "EMAIL") {
        const result = await sendTransactionalEmail({
          to: user.email, subject: request.title, html: request.html ?? `<p>${request.body}</p>`, text: request.body,
          idempotencyKey,
        });
        await prisma.notification.update({
          where: { id: notification.id },
          data: { status: "SENT", sentAt: new Date(), providerMessageId: result?.id },
        });
      } else if (channel === "SMS") {
        const result = await sendSms({ to: user.phone!, body: request.body });
        await prisma.notification.update({
          where: { id: notification.id },
          data: { status: "SENT", sentAt: new Date(), providerMessageId: result.sid },
        });
      } else {
        // IN_APP is delivered by existing — nothing more to do beyond the
        // Notification row itself, which the dashboard already reads.
        await prisma.notification.update({ where: { id: notification.id }, data: { status: "DELIVERED", deliveredAt: new Date() } });
      }
    } catch (error) {
      await prisma.notification.update({
        where: { id: notification.id },
        data: { status: "FAILED", failureReason: error instanceof Error ? error.message : "Unknown delivery error" },
      });
      // Intentionally not rethrown — see the function doc comment. A caller
      // that needs to know about total notification failure should check
      // Sentry/the Notification table, not a thrown exception here.
    }
  }
}

async function recordSuppressed(request: NotificationRequest, channel: NotificationChannel, idempotencyKey: string, _target: string, reason: string) {
  try {
    await prisma.notification.create({
      data: {
        userId: request.userId, type: request.type, channel, title: request.title, body: request.body,
        data: request.data as never, idempotencyKey, status: "SUPPRESSED", failureReason: reason,
      },
    });
  } catch {
    // Already recorded from a prior attempt — fine.
  }
}
