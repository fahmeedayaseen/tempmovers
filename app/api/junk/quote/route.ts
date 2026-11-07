import { NextResponse } from "next/server";
import { z } from "zod";
import { JunkQuoteError } from "@/lib/junk/pricing";
import { findJunkMarketForZip, resolveJunkMarketAvailability } from "@/lib/junk/market-pricing";
import { quoteJunkForMarket } from "@/lib/junk/full-quote";
import { JunkAllocationError } from "@/lib/junk/allocation";
import { junkJobDetailsSchema } from "@/lib/junk/request-schema";

/**
 * Junk removal — VASRUE Digital Media, 28 October 2026.
 *
 * Instant junk-removal estimate (Carl's junk spec §4, step 2). Public on
 * purpose: a customer can see the price before creating an account, and the
 * response carries nothing private — only the market's published prices
 * applied to the details sent. The booking route recomputes the quote from
 * scratch on the server; nothing returned here is ever trusted back.
 *
 * 29 Oct 2026: priced under the full junk allocation (lib/junk/full-quote.ts),
 * so the total already includes any second-helper or crew-minimum adjustment,
 * and the response says how much of it is the disposal set-aside.
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

  // Market Pricing Intelligence (Phase 1): never quote from unapproved example
  // amounts. An unapproved market routes to MANUAL_REVIEW instead of a price.
  const d = parsed.data.details;
  const availability = await resolveJunkMarketAvailability(market.marketCode, {
    serviceLevel: d.serviceLevel,
    pricingMode: d.pricingMode,
    volumeTier: d.pricingMode === "VOLUME" ? (d.volumeTier ?? null) : null,
    items: d.pricingMode === "ITEMS" ? (d.items ?? []).map((i) => i.code) : [],
    specialItems: d.specialItems ?? [],
  });
  if (availability.state !== "AVAILABLE") {
    return NextResponse.json({ error: availability.reason, code: availability.code, state: availability.state }, { status: 409 });
  }

  try {
    const full = await quoteJunkForMarket(market.marketCode, parsed.data.details);
    return NextResponse.json({ market: { name: market.name, state: market.state }, quote: full.publicQuote });
  } catch (e) {
    if (e instanceof JunkQuoteError || e instanceof JunkAllocationError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
