import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { captureIntegrationAlert } from "@/lib/monitoring";

/**
 * Stripe automatically cancels an uncaptured manual-capture PaymentIntent
 * after 7 days — flags jobs/loads whose CURRENT authorization is
 * approaching that window. Flags, does not act — reauthorizing is a
 * real decision that stays a deliberate admin/customer action via the
 * existing cancel + create-intent routes.
 *
 * Fixed after a V25 audit finding: the original version measured age
 * from Job.updatedAt/CarrierRoute.updatedAt, which reflects ANY
 * modification to the parent record, not the moment the current
 * authorization actually became capturable. An unrelated later update
 * could reset that clock and hide a genuinely aging authorization; an
 * old parent record could equally flag something too early. Now
 * queries PaymentAttempt.authorizedAt directly — set by the
 * amount_capturable_updated webhook handler, which is the actual moment
 * this specific authorization became capturable — for the CURRENT
 * attempt (matched by the parent's own stripePaymentIntentId, so a
 * superseded earlier attempt on the same job/load is never what gets
 * measured).
 */
const WARNING_WINDOW_DAYS = 5; // flag with 2 days of runway before Stripe's own 7-day cutoff

export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  const provided = request.headers.get("authorization")?.replace("Bearer ", "");
  if (!secret || provided !== secret) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const cutoff = new Date(Date.now() - WARNING_WINDOW_DAYS * 86_400_000);

  // Prisma can't directly express "column equals sibling column" in a
  // portable way here, so filter to the CURRENT attempt in application
  // code: only an attempt whose stripePaymentIntentId still matches the
  // parent's own stripePaymentIntentId is the live one, not a superseded
  // earlier attempt on the same job/load.
  const candidateAttempts = await prisma.paymentAttempt.findMany({
    where: { paymentStatus: "AUTHORIZED", authorizedAt: { lte: cutoff } },
    include: { job: { select: { stripePaymentIntentId: true } }, load: { select: { stripePaymentIntentId: true } } },
  });
  const currentStaleAttempts = candidateAttempts.filter((a) =>
    (a.jobId && a.job?.stripePaymentIntentId === a.stripePaymentIntentId) ||
    (a.loadId && a.load?.stripePaymentIntentId === a.stripePaymentIntentId),
  );

  const staleJobIds = currentStaleAttempts.filter((a) => a.jobId).map((a) => a.jobId as string);
  const staleLoadIds = currentStaleAttempts.filter((a) => a.loadId).map((a) => a.loadId as string);

  if (staleJobIds.length > 0) {
    captureIntegrationAlert(`${staleJobIds.length} job(s) have an authorization approaching Stripe's 7-day auto-cancellation window.`, {
      area: "payment", jobIds: staleJobIds,
    });
  }
  if (staleLoadIds.length > 0) {
    captureIntegrationAlert(`${staleLoadIds.length} load(s) have an authorization approaching Stripe's 7-day auto-cancellation window.`, {
      area: "payment", loadIds: staleLoadIds,
    });
  }

  return NextResponse.json({
    checked: true, warningWindowDays: WARNING_WINDOW_DAYS,
    staleJobCount: staleJobIds.length, staleJobIds,
    staleLoadCount: staleLoadIds.length, staleLoadIds,
  });
}

// BLOCK-08 — VASRUE Digital Media, 27 October 2026.
// Vercel Cron invokes scheduled routes with GET (sending the same
// "Authorization: Bearer <CRON_SECRET>" header checked above). With POST
// alone every scheduled run returned 405 and did nothing — confirmed on the
// staging deployment. POST stays for manual runs and external schedulers.
export const GET = POST;
