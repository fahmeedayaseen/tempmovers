import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  clientIp,
  honeypotTripped,
  normaliseHasTruck,
  waitlistRateLimited,
  waitlistSignupSchema,
} from "@/lib/waitlist";

/**
 * Launch waitlist signup — VASRUE Digital Media, 29 October 2026.
 *
 * POST /api/waitlist (Carl's waitlist work order §5). Public, no auth.
 *   1. Validates and normalises the email (trimmed, lowercased); malformed is a 400.
 *   2. Honeypot: a filled hidden field gets the same { ok: true } a person
 *      would, and nothing is stored, so a bot learns nothing.
 *   3. Rate limit: about 5 a minute per IP; over that is a 429.
 *   4. Upserts on (email, audience): a repeat submit updates the row, never
 *      errors and never duplicates. The same email may be on both lists.
 *   5. Always answers { ok: true } on success, so the response never reveals
 *      whether the email was already on the list.
 */
export async function POST(request: Request) {
  if (waitlistRateLimited(clientIp(request))) {
    return NextResponse.json({ ok: false, error: "Too many attempts. Please wait a minute and try again." }, { status: 429 });
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ ok: false, error: "Send the form as JSON." }, { status: 400 });
  }
  if (honeypotTripped(body as Record<string, unknown>)) return NextResponse.json({ ok: true });

  const parsed = waitlistSignupSchema.safeParse(body);
  if (!parsed.success) {
    const fields = parsed.error.flatten().fieldErrors;
    const error = fields.email ? "Enter a valid email address." : fields.zipCode ? "Enter a 5-digit ZIP code." : "Check the form and try again.";
    return NextResponse.json({ ok: false, error }, { status: 400 });
  }
  const input = parsed.data;

  // Only fields the person actually filled overwrite an earlier signup.
  const data = {
    zipCode: input.zipCode,
    interests: input.interests,
    hasTruck: normaliseHasTruck(input),
    firstName: input.firstName,
    source: input.source,
  };
  const update: Prisma.WaitlistSignupUpdateInput = {};
  if (data.zipCode !== null) update.zipCode = data.zipCode;
  if (data.interests.length) update.interests = data.interests;
  if (data.hasTruck !== null) update.hasTruck = data.hasTruck;
  if (data.firstName !== null) update.firstName = data.firstName;
  if (data.source !== null) update.source = data.source;

  await prisma.waitlistSignup.upsert({
    where: { email_audience: { email: input.email, audience: input.audience } },
    create: { email: input.email, audience: input.audience, ...data },
    update,
  });

  return NextResponse.json({ ok: true });
}
