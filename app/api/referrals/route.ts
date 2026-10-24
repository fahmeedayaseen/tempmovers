import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { DEFAULT_BONUSES } from "@/lib/bonuses";

const schema = z.object({
  referralCode: z.string().min(1),
  referredEmail: z.string().email().optional(),
  sourceType: z.enum(["MOVER_REFERRAL", "DRIVER_REFERRAL", "PARTNER_REFERRAL"]),
});

export async function POST(request: Request) {
  try {
    await requireRole(request, ["MOVER", "DRIVER", "CUSTOMER", "ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const partner = await prisma.partnerOrganization.findUnique({ where: { referralCode: parsed.data.referralCode } });

  const event = await prisma.referralEvent.create({
    data: {
      partnerId: partner?.id,
      referralCode: parsed.data.referralCode,
      referredEmail: parsed.data.referredEmail,
      sourceType: parsed.data.sourceType,
    },
  });

  // Referral events don't earn anything on creation — a bonus is only awarded once the
  // referred party actually completes the qualifying activity (5th job, 3rd route, etc).
  // See /api/bonuses/evaluate + /api/admin/bonus-awards/:id/review for that step.
  return NextResponse.json({ event }, { status: 201 });
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const referralCode = searchParams.get("referralCode");
  if (!referralCode) return NextResponse.json({ error: "referralCode query param required." }, { status: 400 });
  const events = await prisma.referralEvent.findMany({ where: { referralCode }, orderBy: { createdAt: "desc" } });
  return NextResponse.json({ events, defaultBonuses: DEFAULT_BONUSES });
}
