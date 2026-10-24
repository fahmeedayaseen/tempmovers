import { NextResponse } from "next/server";
import { Webhook } from "svix";
import { prisma } from "@/lib/db";

type ResendEvent = {
  type: "email.sent" | "email.delivered" | "email.delivery_delayed" | "email.bounced" | "email.complained" | "email.opened" | "email.clicked";
  data: { email_id: string; to: string[] };
};

export async function POST(request: Request) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: "Webhook not configured." }, { status: 500 });

  const payload = await request.text();
  const headers = {
    "svix-id": request.headers.get("svix-id") ?? "",
    "svix-timestamp": request.headers.get("svix-timestamp") ?? "",
    "svix-signature": request.headers.get("svix-signature") ?? "",
  };

  const webhook = new Webhook(secret);
  let event: ResendEvent;
  try {
    event = webhook.verify(payload, headers) as ResendEvent;
  } catch {
    return NextResponse.json({ error: "Invalid signature." }, { status: 400 });
  }

  const messageId = event.data?.email_id;
  if (!messageId) return NextResponse.json({ received: true });

  if (event.type === "email.delivered") {
    await prisma.notification.updateMany({ where: { providerMessageId: messageId }, data: { status: "DELIVERED", deliveredAt: new Date() } });
  }

  if (event.type === "email.bounced" || event.type === "email.complained") {
    await prisma.notification.updateMany({ where: { providerMessageId: messageId }, data: { status: "BOUNCED", bouncedAt: new Date() } });

    // Suppress the address going forward — a hard bounce or spam complaint
    // means every future send to this address should stop, not just this
    // one message. queueNotification checks emailSuppressedAt before ever
    // attempting a send.
    for (const to of event.data.to ?? []) {
      await prisma.user.updateMany({
        where: { email: to },
        data: { emailSuppressedAt: new Date(), emailSuppressedReason: event.type === "email.complained" ? "Spam complaint" : "Hard bounce" },
      });
    }
  }

  return NextResponse.json({ received: true });
}
