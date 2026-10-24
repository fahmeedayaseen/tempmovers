import { NextResponse } from "next/server";
import { z } from "zod";
import { calculateBoxTruckLoadQuote, calculateSemiLoadQuote } from "@/lib/pricing";

/**
 * This is an INSTANT QUOTE CALCULATOR, not a carrier bidding/marketplace
 * endpoint — previously named /api/driver-quotes, which was easy to
 * mistake for the multi-carrier quote-comparison workflow described on
 * the homepage (see components/marketing/MarketingHomepage.tsx's
 * NEXT_PUBLIC_FREIGHT_QUOTE_REQUESTS_ENABLED gate). That workflow doesn't
 * exist yet — this just computes a price from a supplied payout amount,
 * the same calculation POST /api/loads uses when a load is actually posted.
 *
 * Box-truck quoting is flat-rate only here — driverPayoutCents, not an
 * hourly rate. The old hourly fields (calculateBoxTruckQuote) are for the
 * separate driver-only/customer-supplies-truck service, which this
 * general quoting endpoint doesn't offer; see app/api/loads/route.ts's
 * explicit serviceType opt-in for that exception path.
 */
const schema = z.discriminatedUnion("vehicleType", [
  z.object({
    vehicleType: z.literal("BOX_TRUCK"),
    driverPayoutCents: z.number().int().positive(),
    accessorialsCents: z.number().int().nonnegative().default(0),
    urgent: z.boolean().optional(),
  }),
  z.object({ vehicleType: z.literal("SEMI"), routeGrossCents: z.number().int().positive() }),
]);

export async function POST(request: Request) {
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  // Freight instant quotes use the freight default fee model
  // (DEDUCT_FROM_PROVIDER) so the calculator matches what a posted freight
  // load will actually quote. A specific market's admin override is applied
  // at posting time in POST /api/loads; this stateless calculator shows the
  // platform default.
  const quote = parsed.data.vehicleType === "BOX_TRUCK"
    ? calculateBoxTruckLoadQuote({ ...parsed.data, feeModel: "DEDUCT_FROM_PROVIDER" })
    : calculateSemiLoadQuote(parsed.data.routeGrossCents, "DEDUCT_FROM_PROVIDER");
  return NextResponse.json(quote);
}
