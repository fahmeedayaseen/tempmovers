import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { checkPhoneVerification, TwilioNotConfiguredError } from "@/lib/twilio";

const schema = z.object({
  phoneNumber: z.string().regex(/^\+[1-9]\d{7,14}$/, "Use E.164 format, e.g. +13175551234."),
  code: z.string().min(4).max(10),
});

export async function POST(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["CUSTOMER", "MOVER", "DRIVER", "ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  let approved: boolean;
  try {
    approved = await checkPhoneVerification(parsed.data.phoneNumber, parsed.data.code);
  } catch (e) {
    if (e instanceof TwilioNotConfiguredError) return NextResponse.json({ error: e.message }, { status: 500 });
    throw e;
  }
  if (!approved) return NextResponse.json({ error: "Invalid verification code." }, { status: 400 });

  await prisma.user.update({
    where: { id: authed.userId },
    data: { phone: parsed.data.phoneNumber, phoneVerifiedAt: new Date() },
  });

  return NextResponse.json({ status: "VERIFIED" });
}
