import { baseLayout, button, APP_URL } from "./base";

export function bookingConfirmationTemplate({ customerName, jobId, scheduledStart }: { customerName: string; jobId: string; scheduledStart: Date }) {
  const url = `${APP_URL}/customer/jobs/${jobId}`;
  return {
    subject: "Your TempMovers booking is confirmed",
    html: baseLayout(`<h1 style="font-size:18px;">Your booking is confirmed</h1><p>Hi ${customerName},</p><p>Your move is scheduled for <strong>${scheduledStart.toLocaleString()}</strong>.</p>${button(url, "View booking")}`),
    text: `Your TempMovers booking is confirmed for ${scheduledStart.toLocaleString()}. View it at ${url}`,
  };
}

export function invitationResponseTemplate({ customerName, workerName, entityTitle, accepted }: { customerName: string; workerName: string; entityTitle: string; accepted: boolean }) {
  return {
    subject: accepted ? `${workerName} accepted your invitation` : `${workerName} declined your invitation`,
    html: baseLayout(`<h1 style="font-size:18px;">${accepted ? "Invitation accepted" : "Invitation declined"}</h1><p>Hi ${customerName},</p><p>${workerName} has ${accepted ? "accepted" : "declined"} your invitation to <strong>${entityTitle}</strong>.${accepted ? "" : " You can invite another worker or leave it open to the marketplace."}</p>`),
    text: `${workerName} has ${accepted ? "accepted" : "declined"} your invitation to ${entityTitle}.`,
  };
}

export function jobInvitationTemplate({ workerName, jobTitle, scheduledStart, expiresAt }: { workerName: string; jobTitle: string; scheduledStart: Date; expiresAt: Date }) {
  return {
    subject: `You're invited: ${jobTitle}`,
    html: baseLayout(`<h1 style="font-size:18px;">A customer invited you to a job</h1><p>Hi ${workerName},</p><p>You've been personally invited to <strong>${jobTitle}</strong>, scheduled for ${scheduledStart.toLocaleString()}. This invitation expires ${expiresAt.toLocaleString()} — accept it before then or it will expire automatically.</p>`),
    text: `You're invited to ${jobTitle}, scheduled ${scheduledStart.toLocaleString()}. Expires ${expiresAt.toLocaleString()}.`,
  };
}

export function assignmentNoticeTemplate({ workerName, jobTitle, publicArea, scheduledStart, jobId }: { workerName: string; jobTitle: string; publicArea: string; scheduledStart: Date; jobId: string }) {
  const url = `${APP_URL}/worker/jobs/${jobId}`;
  return {
    subject: `New job: ${jobTitle}`,
    html: baseLayout(`<h1 style="font-size:18px;">You're booked on a new job</h1><p>Hi ${workerName},</p><p><strong>${jobTitle}</strong> near ${publicArea}, scheduled for ${scheduledStart.toLocaleString()}.</p>${button(url, "View job")}`),
    text: `New job: ${jobTitle} near ${publicArea}, scheduled ${scheduledStart.toLocaleString()}. ${url}`,
  };
}

export function jobReminderTemplate({ recipientName, jobTitle, scheduledStart, jobId }: { recipientName: string; jobTitle: string; scheduledStart: Date; jobId: string }) {
  const url = `${APP_URL}/jobs/${jobId}`;
  return {
    subject: `Reminder: ${jobTitle} tomorrow`,
    html: baseLayout(`<h1 style="font-size:18px;">Upcoming job reminder</h1><p>Hi ${recipientName},</p><p><strong>${jobTitle}</strong> is scheduled for ${scheduledStart.toLocaleString()}.</p>${button(url, "View details")}`),
    text: `Reminder: ${jobTitle} scheduled ${scheduledStart.toLocaleString()}. ${url}`,
  };
}

/**
 * Renders a customer/partner-authored InvitationTemplate (already
 * token-substituted by lib/loads/invite-driver.ts's
 * renderInvitationTemplate) into the same {subject, html, text} shape
 * every other notification template returns, so queueNotification
 * never needs to know whether a given invitation used the default
 * jobInvitationTemplate or a custom one. Body is plain text supplied
 * by the customer — line breaks are preserved as <br>, nothing else is
 * treated as markup, to avoid rendering arbitrary customer-authored
 * HTML in an email.
 */
export function customLoadInvitationTemplate({ subject, body }: { subject: string; body: string }) {
  const escaped = body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
  return {
    subject,
    html: baseLayout(`<h1 style="font-size:18px;">${subject}</h1><p>${escaped}</p>`),
    text: body,
  };
}

export function privateLoadInvitationTemplate({ driverName, loadTitle, invitationId }: { driverName: string; loadTitle: string; invitationId: string }) {
  const url = `${APP_URL}/driver/invitations/${invitationId}`;
  return {
    subject: "You've been invited to a private load",
    html: baseLayout(`<h1 style="font-size:18px;">Private load invitation</h1><p>Hi ${driverName},</p><p>You've been invited to request <strong>${loadTitle}</strong>, a private load not visible on the public board.</p>${button(url, "View invitation")}`),
    text: `You've been invited to a private load: ${loadTitle}. ${url}`,
  };
}
