import { NextResponse } from "next/server";
import { reverifyExpiredCarriers } from "@/lib/fmcsa";
import { captureIntegrationAlert } from "@/lib/monitoring";

/**
 * Configure as a Vercel Cron job (vercel.json) or an external scheduler
 * hitting this URL roughly every 24 hours — see README "Deployment" section.
 * Protected by a shared secret (CRON_SECRET) rather than user auth, since
 * nothing about this request represents a logged-in person.
 */
export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  const provided = request.headers.get("authorization")?.replace("Bearer ", "");
  if (!secret || provided !== secret) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const result = await reverifyExpiredCarriers();
  if (result.failed > 0) {
    captureIntegrationAlert("FMCSA scheduled reverification had failures.", { area: "fmcsa", ...result });
  }
  return NextResponse.json(result);
}

// BLOCK-08 — VASRUE Digital Media, 27 October 2026.
// Vercel Cron invokes scheduled routes with GET (sending the same
// "Authorization: Bearer <CRON_SECRET>" header checked above). With POST
// alone every scheduled run returned 405 and did nothing — confirmed on the
// staging deployment. POST stays for manual runs and external schedulers.
export const GET = POST;
