import { Resend } from "resend";

export class ResendNotConfiguredError extends Error {
  constructor() {
    super("RESEND_API_KEY is not configured.");
  }
}

function client() {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new ResendNotConfiguredError();
  return new Resend(apiKey);
}

export const EMAIL_FROM = process.env.EMAIL_FROM ?? "TempMovers <no-reply@tempmovers.com>";
export const EMAIL_REPLY_TO = process.env.EMAIL_REPLY_TO ?? "support@tempmovers.com";

type SendEmailInput = {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  /** Passed through as Resend's own idempotency key — belt-and-suspenders
   *  with the Notification table's unique constraint in
   *  lib/notifications/index.ts, which is the primary dedup mechanism. */
  idempotencyKey?: string;
};

/**
 * Real implementation against Resend's documented API
 * (https://resend.com/docs/api-reference/emails/send-email) — not a stub.
 * Untested against the live endpoint in this environment (no network
 * access here); treat your first real send as the integration test.
 */
export async function sendTransactionalEmail(input: SendEmailInput) {
  const result = await client().emails.send(
    {
      from: EMAIL_FROM,
      to: input.to,
      replyTo: EMAIL_REPLY_TO,
      subject: input.subject,
      html: input.html,
      text: input.text,
    },
    input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : undefined,
  );

  if (result.error) {
    throw new Error(`Resend failed: ${result.error.message}`);
  }

  return result.data;
}
