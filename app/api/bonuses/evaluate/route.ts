import { NextResponse } from "next/server";
import { z } from "zod";
import { bonusIsEconomicallySafe, qualifiesForThreeFiveStarJobs } from "@/lib/bonuses";

const schema = z.object({
  bonusType: z.enum([
    "CUSTOMER_FIRST_BOOKING_CREDIT",
    "MOVER_FIRST_JOB_BONUS",
    "THREE_FIVE_STAR_JOBS_BONUS",
    "MOVER_REFERRAL_BONUS",
    "DRIVER_REFERRAL_BONUS",
    "PARTNER_REFERRAL_CREDIT",
  ]),
  amountCents: z.number().int().positive(),
  platformRevenueCents: z.number().int().nonnegative(),
  ratings: z.array(z.number().int().min(1).max(5)).optional(),
  completedPaidJobs: z.number().int().nonnegative().default(0),
});

export async function POST(request: Request) {
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const input = parsed.data;
  // Customer credit and mover bonus are separate programs even though both trigger
  // on a "first job" — never conflate them into one qualification check or one record.
  const qualified = input.bonusType === "THREE_FIVE_STAR_JOBS_BONUS"
    ? qualifiesForThreeFiveStarJobs(input.ratings ?? [])
    : input.completedPaidJobs > 0;
  return NextResponse.json({ qualified, safeToApprove: qualified && bonusIsEconomicallySafe(input) });
}
