import { NextResponse } from "next/server";
import { requireRole, AuthError } from "@/lib/auth";
import { settleJob, SettlementError } from "@/lib/payments/settlement";

/**
 * Settle a prepaid job — VASRUE Digital Media, 29 October 2026.
 *
 * POST /api/jobs/[jobId]/settle (admin). Reconciles a completed job under
 * pay-before-dispatch: final amount from approved hours (or the junk
 * allocation), unused prepaid money refunded in full, every collected cent
 * allocated, and worker payouts released. Safe to call again: a second call
 * only retries a refund that did not go through. See lib/payments/settlement.ts.
 */
export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { jobId } = await context.params;
  try {
    const outcome = await settleJob(jobId, authed.userId);
    return NextResponse.json(outcome, { status: outcome.alreadySettled ? 200 : 201 });
  } catch (e) {
    if (e instanceof SettlementError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
