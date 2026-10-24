import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { calculateJobQuote } from "@/lib/pricing";
import { resolveActivePricingRule } from "@/lib/pricing-rules";

/**
 * Pre-booking quote preview (the homepage's "Get an Instant Quote" widget).
 * Doesn't charge anything, but must still show the same platform-controlled
 * rate the real booking flow (POST /api/jobs) will actually use — accepting
 * a client-supplied moverHourlyRateCents here, even just for a preview,
 * would let the widget show a price the customer would never actually be
 * charged. originZip/originState are optional (a marketing-page estimate
 * may not have an address yet); when omitted, this falls back to the same
 * platform default resolveActivePricingRule itself falls back to.
 */
const schema = z.object({
  movers: z.number().int().min(2),
  estimatedHours: z.number().min(3),
  urgent: z.boolean().optional(),
  urgentFeeMode: z.enum(["HOURLY_FEE", "PERCENT_PREMIUM"]).optional(),
  urgentPremiumPercent: z.number().min(0).max(100).optional(),
  includeBookingProtection: z.boolean().optional(),
  originZip: z.string().optional(),
  originState: z.string().length(2).optional(),
});

export async function POST(request: Request) {
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const input = parsed.data;

  let moverHourlyRateCents: number;
  if (input.originState && input.originZip) {
    const market = await prisma.launchMarket.findFirst({
      where: { state: input.originState, zipCodes: { has: input.originZip }, publicBookingEnabled: true },
    });
    if (market) {
      const territory = await prisma.territory.findFirst({
        where: { marketId: market.id, status: "ACTIVE", zipCodes: { has: input.originZip } },
      });
      const rule = await resolveActivePricingRule(market.id, territory?.id);
      moverHourlyRateCents = rule.moverHourlyRateCents;
    } else {
      const rule = await resolveActivePricingRule("");
      moverHourlyRateCents = rule.moverHourlyRateCents;
    }
  } else {
    const rule = await resolveActivePricingRule("");
    moverHourlyRateCents = rule.moverHourlyRateCents;
  }

  return NextResponse.json(calculateJobQuote({ ...input, moverHourlyRateCents }));
}
