import { NextResponse } from "next/server";
import twilio from "twilio";
import { prisma } from "@/lib/db";

/**
 * Handles two distinct things Twilio posts to this same style of endpoint:
 * 1. Delivery status callbacks for messages sent via the Messaging Service
 *    (queued/sent/delivered/undelivered/failed) — updates the matching
 *    Notification row by providerMessageId.
 * 2. Inbound STOP/HELP/START keywords texted back to the number — required
 *    for TCPA/A2P 10DLC compliance. STOP sets smsOptOutAt; START clears it.
 *
 * Verifies Twilio's request signature before trusting anything in the body
 * — this endpoint moves compliance-relevant state (opt-out status), so an
 * unverified POST here is not something to act on.
 */
export async function POST(request: Request) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) return NextResponse.json({ error: "Twilio not configured." }, { status: 500 });

  const signature = request.headers.get("x-twilio-signature");
  const url = request.url;
  const formData = await request.formData();
  const params: Record<string, string> = {};
  formData.forEach((value, key) => { params[key] = String(value); });

  if (!signature || !twilio.validateRequest(authToken, signature, url, params)) {
    return NextResponse.json({ error: "Invalid signature." }, { status: 400 });
  }

  // Delivery status callback.
  if (params.MessageStatus && params.MessageSid) {
    const statusMap: Record<string, "SENT" | "DELIVERED" | "FAILED" | "BOUNCED"> = {
      sent: "SENT", delivered: "DELIVERED", undelivered: "BOUNCED", failed: "FAILED",
    };
    const mapped = statusMap[params.MessageStatus];
    if (mapped) {
      await prisma.notification.updateMany({
        where: { providerMessageId: params.MessageSid },
        data: {
          status: mapped,
          ...(mapped === "DELIVERED" && { deliveredAt: new Date() }),
          ...(mapped === "BOUNCED" && { bouncedAt: new Date() }),
        },
      });
    }
  }

  // Inbound keyword handling — Twilio Advanced Opt-Out normally handles
  // STOP/HELP/START automatically at the carrier/Twilio level, but this
  // keeps our own User.smsOptOutAt in sync regardless, since that field
  // (not Twilio's own suppression list) is what queueNotification checks.
  if (params.Body && params.From) {
    const keyword = params.Body.trim().toUpperCase();
    const user = await prisma.user.findFirst({ where: { phone: params.From } });
    if (user) {
      if (["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"].includes(keyword)) {
        await prisma.user.update({ where: { id: user.id }, data: { smsOptOutAt: new Date() } });
      } else if (["START", "YES", "UNSTOP"].includes(keyword)) {
        await prisma.user.update({ where: { id: user.id }, data: { smsOptOutAt: null } });
      }
      // HELP is expected to be answered by Twilio's own auto-reply
      // configuration on the Messaging Service, not application code.
    }
  }

  return new NextResponse("", { status: 200 });
}
