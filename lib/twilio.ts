import twilio from "twilio";

export class TwilioNotConfiguredError extends Error {
  constructor() {
    super("Twilio credentials are not configured.");
  }
}

function client() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) throw new TwilioNotConfiguredError();
  return twilio(accountSid, authToken);
}

/**
 * Sends a single SMS via the Messaging Service (not a raw from-number send)
 * so Twilio's own delivery optimization/number pooling applies. Real
 * implementation against Twilio's documented API, untested against the
 * live endpoint in this environment (no network access here).
 */
export async function sendSms({ to, body }: { to: string; body: string }) {
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
  if (!messagingServiceSid) throw new Error("TWILIO_MESSAGING_SERVICE_SID is not configured.");
  return client().messages.create({ to, body, messagingServiceSid });
}

/** Starts an SMS verification code send via Twilio Verify. */
export async function startPhoneVerification(phoneNumber: string) {
  const serviceSid = process.env.TWILIO_VERIFY_SERVICE_SID;
  if (!serviceSid) throw new Error("TWILIO_VERIFY_SERVICE_SID is not configured.");
  return client().verify.v2.services(serviceSid).verifications.create({ to: phoneNumber, channel: "sms" });
}

/** Confirms a code the user entered. Returns true only if Twilio reports "approved". */
export async function checkPhoneVerification(phoneNumber: string, code: string): Promise<boolean> {
  const serviceSid = process.env.TWILIO_VERIFY_SERVICE_SID;
  if (!serviceSid) throw new Error("TWILIO_VERIFY_SERVICE_SID is not configured.");
  const result = await client().verify.v2.services(serviceSid).verificationChecks.create({ to: phoneNumber, code });
  return result.status === "approved";
}
