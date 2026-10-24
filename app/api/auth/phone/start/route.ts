import { NextResponse } from "next/server";
import { z } from "zod";
import { requireRole, AuthError } from "@/lib/auth";
import { startPhoneVerification, TwilioNotConfiguredError } from "@/lib/twilio";

const schema = z.object({ phoneNumber: z.string().regex(/^\+[1-9]\d{7,14}$/, "Use E.164 format, e.g. +13175551234.") });

export async function POST(request: Request) {
  try {
    await requireRole(request, ["CUSTOMER", "MOVER", "DRIVER", "ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  try {
    await startPhoneVerification(parsed.data.phoneNumber);
  } catch (e) {
    if (e instanceof TwilioNotConfiguredError) return NextResponse.json({ error: e.message }, { status: 500 });
    throw e;
  }

  return NextResponse.json({ status: "CODE_SENT" });
}
