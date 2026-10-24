import { NextResponse } from "next/server";
import { reconcilePendingCheckrEvents } from "@/lib/screening/reconcile-checkr-events";
import { captureIntegrationAlert } from "@/lib/monitoring";

/**
 * Configure as a Vercel Cron job (vercel.json) or an external scheduler —
 * every 15-30 minutes is reasonable, since pending events represent a
 * webhook ordering race that should usually resolve within minutes, not
 * hours. Protected by the same shared secret pattern as the FMCSA cron.
 */
export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  const provided = request.headers.get("authorization")?.replace("Bearer ", "");
  if (!secret || provided !== secret) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const result = await reconcilePendingCheckrEvents();
  if (result.failed > 0) {
    captureIntegrationAlert("Checkr event reconciliation had failures.", { area: "checkr", ...result });
  }
  return NextResponse.json(result);
}
