import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { calculateJobQuote } from "@/lib/pricing";
import { resolveActivePricingRule } from "@/lib/pricing-rules";
import { requireRole, AuthError } from "@/lib/auth";
import { geocodeAddress, GeocodingNotConfiguredError } from "@/lib/geocoding";
import { queueNotification } from "@/lib/notifications";
import { bookingConfirmationTemplate } from "@/lib/email/templates/booking";
import { SANITIZED_JOB_FEED_SELECT } from "@/lib/access/sanitize-job";
import { canTakeJunkJobs, isJunkOnlyWorkerType, junkCrewRoleFor, junkSeats, JUNK_SEAT_HOLDING_STATUSES } from "@/lib/junk/crew";
import type { Prisma } from "@prisma/client";

// Server-side minimums are repeated here even though the client also enforces them —
// a client can always be bypassed, so this is the actual source of truth.
const schema = z.object({
  addressId: z.string().cuid(),
  title: z.string().min(3),
  description: z.string().optional(),
  type: z.enum([
    "RESIDENTIAL_MOVE", "COMMERCIAL_MOVE", "LOADING", "UNLOADING",
    "LABOR_ONLY", "FURNITURE_DELIVERY", "STORAGE_MOVE",
  ]),
  startsAt: z.string().datetime(),
  estimatedHours: z.number().min(3),
  movers: z.number().int().min(2),
  urgent: z.boolean().optional(),
  postingMode: z.enum(["OPEN_MARKETPLACE", "PREFERRED_NETWORK_FIRST", "INVITE_SPECIFIC_WORKERS", "PRIVATE_INVITATION_ONLY"]).optional(),
});

export async function POST(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["CUSTOMER", "ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const input = parsed.data;

  const customerProfile = await prisma.customerProfile.findUnique({ where: { userId: authed.userId } });
  if (!customerProfile) return NextResponse.json({ error: "No customer profile for this account." }, { status: 403 });

  const address = await prisma.address.findFirst({
    where: { id: input.addressId, customerId: customerProfile.id },
  });
  if (!address) {
    return NextResponse.json({ error: "Address not found or does not belong to this customer." }, { status: 404 });
  }

  let jobLatitude: number | null = address.latitude ? Number(address.latitude) : null;
  let jobLongitude: number | null = address.longitude ? Number(address.longitude) : null;

  let needsManualGeoReview = false;

  if (!jobLatitude || !jobLongitude) {
    try {
      const geocoded = await geocodeAddress(`${address.line1}, ${address.city}, ${address.state} ${address.postalCode}`);
      if (!geocoded) {
        return NextResponse.json({ error: "This address could not be validated. Check it and try again." }, { status: 400 });
      }
      await prisma.address.update({
        where: { id: address.id },
        data: { latitude: geocoded.latitude, longitude: geocoded.longitude, placeId: geocoded.placeId, geocodedAt: new Date() },
      });
      jobLatitude = geocoded.latitude;
      jobLongitude = geocoded.longitude;
    } catch (e) {
      if (!(e instanceof GeocodingNotConfiguredError)) throw e;
      // No Google Maps key configured — proceed without coordinates rather
      // than blocking every booking on an optional provider. Worker
      // service-radius matching just falls back to market/territory
      // membership alone until this is configured (see lib/geo.ts) — but
      // that degradation is now flagged for admin review, not silent.
      needsManualGeoReview = true;
    }
  }

  // A job created without a market is invisible to every mover — job
  // acceptance is geographically gated (see lib/geo.ts) — so this is not
  // optional metadata, it's what makes the job reachable at all.
  const market = await prisma.launchMarket.findFirst({
    where: { state: address.state, zipCodes: { has: address.postalCode }, publicBookingEnabled: true },
  });
  if (!market) {
    return NextResponse.json({ error: "TempMovers is not currently accepting bookings in this area." }, { status: 409 });
  }
  const territory = await prisma.territory.findFirst({
    where: { marketId: market.id, status: "ACTIVE", zipCodes: { has: address.postalCode } },
  });

  // Platform-controlled: movers do not set their own wage, customers do not
  // choose it. This is the only source of truth for moverHourlyRateCents —
  // never a client-supplied value.
  const pricingRule = await resolveActivePricingRule(market.id, territory?.id);

  const quote = calculateJobQuote({
    moverHourlyRateCents: pricingRule.moverHourlyRateCents,
    movers: input.movers,
    estimatedHours: input.estimatedHours,
    urgent: input.urgent,
    includeBookingProtection: true,
  });

  const job = await prisma.job.create({
    data: {
      customerId: customerProfile.id,
      addressId: address.id,
      marketId: market.id,
      territoryId: territory?.id,
      latitude: jobLatitude,
      longitude: jobLongitude,
      needsManualGeoReview,
      title: input.title,
      description: input.description,
      type: input.type,
      postingMode: input.postingMode,
      startsAt: new Date(input.startsAt),
      estimatedHours: quote.billableHours,
      minimumHours: 3,
      moversRequired: quote.movers,
      customerMoverRateCents: pricingRule.moverHourlyRateCents,
      platformFeePerHourCents: quote.platformFeePerManHourCents,
      urgentPremiumCents: quote.urgentPremiumCents,
      bookingProtectionFeeCents: quote.bookingProtectionFeeCents,
      estimatedSubtotalCents: quote.laborCents,
      estimatedPlatformFeeCents: quote.platformFeeCents,
      estimatedTotalCents: quote.totalCents,
    },
  });

  const customerUser = await prisma.user.findUnique({ where: { id: authed.userId }, select: { id: true, firstName: true } });
  if (customerUser) {
    const { subject, html, text } = bookingConfirmationTemplate({
      customerName: customerUser.firstName, jobId: job.id, scheduledStart: job.startsAt,
    });
    await queueNotification({
      userId: customerUser.id, type: "BOOKING_CONFIRMATION", channels: ["EMAIL", "IN_APP"],
      title: subject, body: text, html, idempotencyKey: `booking-confirmed:${job.id}`,
    });
  }

  return NextResponse.json({ job, quote }, { status: 201 });
}

export async function GET(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["CUSTOMER", "MOVER", "DRIVER", "ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  if (authed.role === "ADMIN") {
    const { searchParams } = new URL(request.url);
    const customerId = searchParams.get("customerId");
    const jobs = await prisma.job.findMany({
      where: customerId ? { customerId } : undefined,
      orderBy: { startsAt: "asc" },
      take: 50,
    });
    return NextResponse.json({ jobs });
  }

  if (authed.role === "CUSTOMER") {
    // A customer sees only their own jobs, full detail — they own this data.
    const customerProfile = await prisma.customerProfile.findUnique({ where: { userId: authed.userId } });
    if (!customerProfile) return NextResponse.json({ jobs: [] });
    const jobs = await prisma.job.findMany({
      where: { customerId: customerProfile.id },
      orderBy: { startsAt: "asc" },
      take: 50,
    });
    return NextResponse.json({ jobs });
  }

  // MOVER / DRIVER: sanitized previews only. This mirrors
  // GET /api/driver/loads' existing pattern (browsing allowed regardless of
  // onboarding/screening completeness, only *requesting* is gated) — see
  // lib/access/opportunity-access.ts for the equivalent policy.
  //
  // Junk removal — VASRUE Digital Media, 28 Oct 2026. Junk jobs reach only workers who can
  // take them (a junk-only account, or a mover / box-truck driver who has
  // switched junk on), and a junk-only account sees nothing else. A junk job
  // whose seat for this worker is already filled is left out. `?service=junk`
  // or `?service=moving` narrows the feed further.
  const worker = await prisma.workerProfile.findUnique({ where: { userId: authed.userId }, select: { workerType: true, junkRemovalEnabled: true } });
  const junkOk = worker ? canTakeJunkJobs(worker) : false;
  const junkOnly = worker ? isJunkOnlyWorkerType(worker.workerType) : false;
  const service = new URL(request.url).searchParams.get("service");
  let typeWhere: Prisma.JobWhereInput["type"];
  if (service === "junk" || junkOnly) typeWhere = junkOk ? "JUNK_REMOVAL" : { in: [] };
  else if (service === "moving" || !junkOk) typeWhere = { not: "JUNK_REMOVAL" };

  const jobs = await prisma.job.findMany({
    where: {
      status: { in: ["POSTED", "MATCHING", "PARTIALLY_FILLED"] }, postingMode: { notIn: ["INVITE_SPECIFIC_WORKERS", "PRIVATE_INVITATION_ONLY"] },
      ...(typeWhere !== undefined && { type: typeWhere }),
    },
    select: SANITIZED_JOB_FEED_SELECT,
    orderBy: { startsAt: "asc" },
    take: 50,
  });

  const junkIds = jobs.filter((j) => j.type === "JUNK_REMOVAL").map((j) => j.id);
  if (junkIds.length === 0) return NextResponse.json({ jobs });
  const held = await prisma.assignment.findMany({
    where: { jobId: { in: junkIds }, status: { in: [...JUNK_SEAT_HOLDING_STATUSES] } },
    select: { jobId: true, junkCrewRole: true },
  });
  const myRole = worker ? junkCrewRoleFor(worker.workerType) : null;
  const withSeats = jobs.flatMap((j) => {
    if (j.type !== "JUNK_REMOVAL" || !j.junkRemovalDetail) return [j];
    const seats = junkSeats({ helpersRequired: j.junkRemovalDetail.helpersRequired, filledRoles: held.filter((h) => h.jobId === j.id).map((h) => h.junkCrewRole) });
    const open = myRole === "HAULER" ? seats.haulerOpen : seats.helpersOpen > 0;
    return open ? [{ ...j, junkSeats: seats }] : [];
  });
  return NextResponse.json({ jobs: withSeats });
}
