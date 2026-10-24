import { baseLayout, button, APP_URL } from "./base";

export function documentStatusTemplate({ workerName, documentLabel, status, reason }: { workerName: string; documentLabel: string; status: "SUBMITTED" | "APPROVED" | "REJECTED" | "EXPIRING"; reason?: string }) {
  const url = `${APP_URL}/onboarding/driver`;
  const copy: Record<typeof status, { subject: string; line: string }> = {
    SUBMITTED: { subject: `${documentLabel} received`, line: `We've received your ${documentLabel.toLowerCase()} and it's under review.` },
    APPROVED: { subject: `${documentLabel} approved`, line: `Your ${documentLabel.toLowerCase()} has been approved.` },
    REJECTED: { subject: `${documentLabel} needs attention`, line: `Your ${documentLabel.toLowerCase()} was not approved${reason ? `: ${reason}` : "."} Please resubmit.` },
    EXPIRING: { subject: `${documentLabel} expiring soon`, line: `Your ${documentLabel.toLowerCase()} is expiring soon. Upload a current copy to keep accepting jobs without interruption.` },
  };
  const { subject, line } = copy[status];
  return {
    subject: `TempMovers: ${subject}`,
    html: baseLayout(`<h1 style="font-size:18px;">${subject}</h1><p>Hi ${workerName},</p><p>${line}</p>${button(url, "Go to onboarding")}`),
    text: `${subject}: ${line} ${url}`,
  };
}

export function reviewRequestTemplate({ customerName, jobTitle, jobId }: { customerName: string; jobTitle: string; jobId: string }) {
  const url = `${APP_URL}/customer/jobs/${jobId}/review`;
  return {
    subject: "How was your move?",
    html: baseLayout(`<h1 style="font-size:18px;">Rate your move</h1><p>Hi ${customerName},</p><p>Your job <strong>${jobTitle}</strong> is complete. Rate the movers who helped — it takes less than a minute.</p>${button(url, "Leave a review")}`),
    text: `How was your move? Rate ${jobTitle}: ${url}`,
  };
}

export function workerAccountStatusTemplate({
  workerName, status, reason,
}: { workerName: string; status: "APPROVED" | "REJECTED" | "RESTRICTED" | "SUSPENDED" | "REACTIVATED"; reason?: string | null }) {
  const url = `${APP_URL}/onboarding/driver`;
  const copy: Record<typeof status, { subject: string; line: string }> = {
    APPROVED: { subject: "You're approved to work", line: "Your TempMovers account has been approved — you can now accept jobs and loads." },
    REJECTED: { subject: "Your application needs attention", line: `Your TempMovers application was not approved${reason ? `: ${reason}` : "."}` },
    RESTRICTED: { subject: "Your account access has changed", line: `Your TempMovers account is now restricted${reason ? `: ${reason}` : "."} Contact support if you have questions.` },
    SUSPENDED: { subject: "Your account has been suspended", line: `Your TempMovers account has been suspended${reason ? `: ${reason}` : "."} Contact support if you believe this is an error.` },
    REACTIVATED: { subject: "Your account is active again", line: "Your TempMovers account has been reactivated — you can accept jobs and loads again." },
  };
  const { subject, line } = copy[status];
  return {
    subject: `TempMovers: ${subject}`,
    html: baseLayout(`<h1 style="font-size:18px;">${subject}</h1><p>Hi ${workerName},</p><p>${line}</p>${status === "APPROVED" || status === "REACTIVATED" ? button(url, "Go to your dashboard") : ""}`),
    text: `${subject}: ${line}`,
  };
}
