import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { getCarrierEligibility } from "@/lib/carriers/eligibility-service";

/**
 * Carrier-facing eligibility read (gap contract #1). Resolves the carrier by
 * ownerUserId, reuses the central getCarrierEligibility service (no duplicated
 * logic), and enriches each structured blocker with a corrective ACTION so the
 * dashboard can show an actionable instruction instead of a generic
 * "Not eligible". Carrier-scoped: a caller only ever sees their own carrier.
 */

// Corrective actions per blocker code. The eligibility core stays {code,message};
// the carrier-facing action lives here so the dashboard can guide the carrier.
const ACTIONS: Record<string, string> = {
  CARRIER_NOT_ACTIVE: "Complete onboarding and pass review to activate your account.",
  ADMINISTRATIVE_HOLD: "Contact TempMovers support to resolve the hold on your account.",
  AUTO_LIABILITY_INSURANCE_INVALID: "Upload a current auto-liability policy for review.",
  CARGO_INSURANCE_INVALID: "Upload a current cargo insurance policy for review.",
  GENERAL_LIABILITY_INSURANCE_INVALID: "Upload a current general-liability policy for review.",
  FMCSA_NOT_AUTHORIZED: "We could not confirm active FMCSA authority. Verify your DOT/MC details.",
  FMCSA_CHECK_STALE: "Your FMCSA verification needs to be refreshed.",
  AGREEMENT_MISSING: "Review and acknowledge the required carrier agreement.",
  PAYMENT_ROUTING_UNDER_REVIEW: "Your payment routing is under review; no action is needed yet.",
  MARKET_NOT_ELIGIBLE: "This capability is not yet available in your market.",
};

function actionFor(code: string): string {
  if (ACTIONS[code]) return ACTIONS[code];
  if (code.startsWith("DOCUMENT_NOT_APPROVED_")) return "Upload the required document, or wait for review to complete.";
  return "Contact TempMovers support for next steps.";
}

export async function GET(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["CARRIER", "ADMIN", "SUPER_ADMIN"] as unknown as ("ADMIN")[]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const carrier = await prisma.carrier.findUnique({ where: { ownerUserId: authed.userId }, select: { id: true, marketId: true } });
  if (!carrier) return NextResponse.json({ error: "No carrier profile." }, { status: 404 });

  // Carrier eligibility for the launch-relevant capability. This reuses the
  // central service; we only add carrier-facing corrective actions.
  const result = await getCarrierEligibility(carrier.id, "RECEIVE_LOAD_OFFER", carrier.marketId);

  return NextResponse.json({
    eligible: result.eligible,
    blockers: result.blockers.map((b) => ({ code: b.code, message: b.message, action: actionFor(b.code) })),
  });
}
