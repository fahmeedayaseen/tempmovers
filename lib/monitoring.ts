import * as Sentry from "@sentry/nextjs";

/**
 * For the specific "nothing threw, but this needs a human" cases: a
 * PayoutOperation stuck in PROCESSING, a payment captured without its
 * completion accounting running, an insurance lapse that isn't yet
 * restricting a worker, etc. Sentry's automatic instrumentation (from the
 * sentry.*.config.ts files) already captures thrown exceptions — this is
 * for the cases that DON'T throw and would otherwise be silent.
 */
export function captureIntegrationAlert(
  message: string,
  context: { area: "stripe" | "payment" | "billing" | "payout" | "resend" | "twilio" | "checkr" | "fmcsa" | "insurance" | "load-board"; [key: string]: unknown },
) {
  Sentry.captureMessage(message, { level: "warning", tags: { area: context.area }, extra: context });
}
