import { NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { geocodeAddress, GeocodingNotConfiguredError } from "@/lib/geocoding";
import { queueNotification } from "@/lib/notifications";
import { bookingConfirmationTemplate } from "@/lib/email/templates/booking";
import { JunkQuoteError, JUNK_TIER_INFO } from "@/lib/junk/pricing";
import { findJunkMarketForZip, resolveJunkMarketAvailability } from "@/lib/junk/market-pricing";
import { quoteJunkForMarket } from "@/lib/junk/full-quote";
import { JunkAllocationError } from "@/lib/junk/allocation";
import { recordQuoteVersion } from "@/lib/payments/funding";
import { junkJobDetailsSchema } from "@/lib/junk/request-schema";
import { isKeyUnder, junkBookingPhotoPrefix, MAX_JUNK_PHOTOS_PER_SET } from "@/lib/junk/storage-keys";

/**
 * Junk removal — VASRUE Digital Media, 28 October 2026.
 *
 * Books a junk removal job (Carl's junk spec §4). Creates the Job and its
 * JunkRemovalDetail together, in DRAFT, exactly like a moving booking: the
 * job reaches the junk board only once Stripe confirms the authorisation
 * (the webhook's DRAFT -> POSTED step), so no crew can take an unfunded job.
 * The customer then authorises through the existing
 * POST /api/stripe/job-payment-intent, which charges job.estimatedTotalCents.
 *
 * The price is recomputed here from the market's own pricing — never taken
 * from the request — and snapshotted onto the booking.
 *
 * Pay before dispatch — VASRUE Digital Media, 29 October 2026. Priced under
 * the full junk allocation (payment spec §5–§6, junk spec §5a): the disposal
 * set-aside is carved out of the all-in price, the platform fee is taken on
 * the service subtotal only, helpers are planned hourly, and the hauler
 * gets the rest plus the disposal reimbursement. The quote is written as an
 * immutable QuoteVersion with that plan, and a DisposalExpense row holds the
 * set-aside until the dump receipt settles it. The customer pays the full
 * total before any crew is dispatched; the job reaches the board only once
 * the payment is collected.
 */
const schema = z.object({
  addressId: z.string().cuid(),
  startsAt: z.string().datetime(),
  accessNotes: z.string().max(1000).optional(),
  itemNotes: z.string().max(1000).optional(),
  photoKeys: z.array(z.string().max(300)).max(MAX_JUNK_PHOTOS_PER_SET).default([]),
  details: junkJobDetailsSchema,
});

export async function POST(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["CUSTOMER", "ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const input = parsed.data;

  const startsAt = new Date(input.startsAt);
  if (startsAt.getTime() < Date.now() + 60 * 60 * 1000) {
    return NextResponse.json({ error: "Choose a pickup time at least an hour from now." }, { status: 400 });
  }

  const customerProfile = await prisma.customerProfile.findUnique({ where: { userId: authed.userId } });
  if (!customerProfile) return NextResponse.json({ error: "No customer profile for this account." }, { status: 403 });

  const address = await prisma.address.findFirst({ where: { id: input.addressId, customerId: customerProfile.id } });
  if (!address) return NextResponse.json({ error: "Address not found or does not belong to this customer." }, { status: 404 });

  const photoPrefix = junkBookingPhotoPrefix(customerProfile.id);
  if (input.photoKeys.some((k) => !isKeyUnder(k, photoPrefix))) {
    return NextResponse.json({ error: "One of the photos was not uploaded through this account." }, { status: 400 });
  }

  // Same coordinate handling as POST /api/jobs: geocode when Google Maps is
  // configured, otherwise book without coordinates and flag for admin review.
  let latitude: number | null = address.latitude ? Number(address.latitude) : null;
  let longitude: number | null = address.longitude ? Number(address.longitude) : null;
  let needsManualGeoReview = false;
  if (!latitude || !longitude) {
    try {
      const geocoded = await geocodeAddress(`${address.line1}, ${address.city}, ${address.state} ${address.postalCode}`);
      if (!geocoded) return NextResponse.json({ error: "This address could not be validated. Check it and try again." }, { status: 400 });
      await prisma.address.update({
        where: { id: address.id },
        data: { latitude: geocoded.latitude, longitude: geocoded.longitude, placeId: geocoded.placeId, geocodedAt: new Date() },
      });
      latitude = geocoded.latitude;
      longitude = geocoded.longitude;
    } catch (e) {
      if (!(e instanceof GeocodingNotConfiguredError)) throw e;
      needsManualGeoReview = true;
    }
  }

  // The per-market junk switch (LaunchMarket.junkRemovalEnabled) is the gate.
  const market = await findJunkMarketForZip(address.postalCode, address.state);
  if (!market) {
    return NextResponse.json({ error: "Junk removal isn't available at this address yet.", code: "JUNK_NOT_AVAILABLE" }, { status: 409 });
  }
  // Never book (and never collect payment) against unapproved example pricing
  // (directive §5/§94): an unapproved market cannot produce a bookable quote.
  const availability = await resolveJunkMarketAvailability(market.marketCode);
  if (availability.state !== "AVAILABLE") {
    return NextResponse.json({ error: availability.reason, code: availability.code, state: availability.state }, { status: 409 });
  }
  const territory = await prisma.territory.findFirst({
    where: { marketId: market.id, status: "ACTIVE", zipCodes: { has: address.postalCode.slice(0, 5) } },
  });

  let full;
  try {
    full = await quoteJunkForMarket(market.marketCode, input.details);
  } catch (e) {
    if (e instanceof JunkQuoteError || e instanceof JunkAllocationError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
  const { base: quote, plan } = full;

  const d = input.details;
  const what = d.pricingMode === "VOLUME" && d.volumeTier
    ? JUNK_TIER_INFO[d.volumeTier].label
    : `${(d.items ?? []).reduce((n, i) => n + i.quantity, 0)} item(s)`;

  const job = await prisma.job.create({
    data: {
      customerId: customerProfile.id,
      addressId: address.id,
      marketId: market.id,
      territoryId: territory?.id,
      latitude,
      longitude,
      needsManualGeoReview,
      title: `Junk removal — ${what} — ${address.city}`,
      description: input.accessNotes,
      type: "JUNK_REMOVAL",
      postingMode: "OPEN_MARKETPLACE",
      startsAt,
      estimatedHours: quote.estimatedHours,
      // Junk is a fixed all-in price; helper time is planned in the quote plan.
      minimumHours: 0,
      moversRequired: quote.crewSize,
      customerMoverRateCents: 0,
      platformFeePerHourCents: 0,
      urgentPremiumCents: 0,
      bookingProtectionFeeCents: quote.bookingProtectionFeeCents,
      // total = subtotal + platform fee + booking protection, the same identity
      // every other job keeps: here the subtotal is the crew's pay plus the
      // disposal set-aside, and the fee is 30% of the service subtotal.
      estimatedSubtotalCents: plan.allInCents - plan.platformFeeCents,
      estimatedPlatformFeeCents: plan.platformFeeCents,
      estimatedTotalCents: plan.totalCents,
      pricingSnapshot: plan as unknown as Prisma.InputJsonObject,
      junkRemovalDetail: {
        create: {
          pricingMode: d.pricingMode,
          volumeTier: d.pricingMode === "VOLUME" ? d.volumeTier : null,
          items: d.pricingMode === "ITEMS" ? (d.items as unknown as Prisma.InputJsonArray) : undefined,
          itemCategories: d.itemCategories,
          itemNotes: input.itemNotes,
          itemLocation: d.itemLocation,
          hasHeavyItems: d.hasHeavyItems,
          serviceLevel: d.serviceLevel,
          specialItems: d.specialItems,
          photoKeys: input.photoKeys,
          servicePriceCents: quote.servicePriceCents,
          surchargesCents: quote.surchargesCents,
          takeRatePercent: Math.round(plan.platformFeeBps / 100),
          platformTakeCents: plan.platformFeeCents,
          crewPoolCents: plan.allInCents - plan.platformFeeCents,
          helpersRequired: quote.helpersRequired,
          // Helpers are paid hourly now, not a share; these are the planned amounts.
          helperSharePercent: 0,
          haulerShareCents: plan.haulerServiceCents,
          helperShareCents: plan.helperCompCents[0] ?? 0,
          estimatedDumpFeeCents: plan.disposalCents,
        },
      },
    },
    select: { id: true, title: true, status: true, startsAt: true, estimatedTotalCents: true, paymentStatus: true },
  });

  await recordQuoteVersion({ type: "JOB", id: job.id }, {
    totalCents: plan.totalCents,
    lines: full.publicQuote.lines as unknown as Prisma.InputJsonArray,
    plan: plan as unknown as Prisma.InputJsonObject,
    createdByUserId: authed.userId,
  });
  await prisma.disposalExpense.create({ data: { jobId: job.id, estimatedCents: plan.disposalCents } });

  const customerUser = await prisma.user.findUnique({ where: { id: authed.userId }, select: { id: true, firstName: true } });
  if (customerUser) {
    const { subject, html, text } = bookingConfirmationTemplate({ customerName: customerUser.firstName, jobId: job.id, scheduledStart: job.startsAt, service: "junk removal pickup" });
    await queueNotification({
      userId: customerUser.id, type: "BOOKING_CONFIRMATION", channels: ["EMAIL", "IN_APP"],
      title: subject, body: text, html, idempotencyKey: `booking-confirmed:${job.id}`,
    });
  }

  await prisma.auditLog.create({
    data: { actorId: authed.userId, action: "JUNK_JOB_BOOKED", entityType: "Job", entityId: job.id, details: { marketCode: market.marketCode, totalCents: plan.totalCents, crewSize: quote.crewSize, repriced: plan.repriced, policyVersion: plan.policyVersion } },
  });

  // The crew split stays internal: the customer gets the job and its all-in price.
  return NextResponse.json({ job, quote: full.publicQuote }, { status: 201 });
}
