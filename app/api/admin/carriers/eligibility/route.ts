import { NextResponse } from "next/server";
import { requireRole, AuthError } from "@/lib/auth";
import { getCarrierEligibility, type CarrierCapability } from "@/lib/carriers/eligibility-service";

/**
 * Carrier eligibility check (launch spec §3). Thin endpoint over the central
 * getCarrierEligibility service — returns structured { eligible, blockers }.
 * Load-offer and carrier-assignment endpoints call the service directly; this
 * endpoint lets admins and the carrier portal see the same result.
 */
const ROLES = ["CARRIER", "ADMIN", "SUPPORT", "FINANCE_ADMIN", "SUPER_ADMIN"] as const;

export async function GET(request: Request) {
  try {
    await requireRole(request, ROLES as unknown as ("ADMIN")[]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const url = new URL(request.url);
  const carrierId = url.searchParams.get("carrierId");
  const capability = (url.searchParams.get("capability") ?? "RECEIVE_LOAD_OFFER") as CarrierCapability;
  const marketId = url.searchParams.get("marketId");
  if (!carrierId) return NextResponse.json({ error: "carrierId is required." }, { status: 400 });

  const result = await getCarrierEligibility(carrierId, capability, marketId);
  return NextResponse.json(result);
}
