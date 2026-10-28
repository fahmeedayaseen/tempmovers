import { NextResponse } from "next/server";
import { z } from "zod";
import { calculateJunkQuote, JunkQuoteError, toPublicJunkQuote } from "@/lib/junk/pricing";
import { findJunkMarketForZip, resolveJunkMarketPricing } from "@/lib/junk/market-pricing";
import { junkJobDetailsSchema } from "@/lib/junk/request-schema";

/**
 * Junk removal — VASRUE Digital Media, 28 October 2026.
 *
 * Instant junk-removal estimate (Carl's junk spec §4, step 2). Public on
 * purpose: a customer can see the price before creating an account, and the
 * response carries nothing private — only the market's published prices
 * applied to the details sent. The booking route recomputes the quote from
 * scratch on the server; nothing returned here is ever trusted back.
 */
const schema = z.object({
  postalCode: z.string().regex(/^\d{5}(?:-\d{4})?$/, "Enter a valid ZIP code."),
  details: junkJobDetailsSchema,
});

export async function POST(request: Request) {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const market = await findJunkMarketForZip(parsed.data.postalCode);
  if (!market) {
    return NextResponse.json({ error: "Junk removal isn't available in this area yet.", code: "JUNK_NOT_AVAILABLE" }, { status: 409 });
  }

  const pricing = await resolveJunkMarketPricing(market.marketCode);
  try {
    const quote = calculateJunkQuote({ ...pricing, ...parsed.data.details });
    return NextResponse.json({ market: { name: market.name, state: market.state }, quote: toPublicJunkQuote(quote) });
  } catch (e) {
    if (e instanceof JunkQuoteError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
