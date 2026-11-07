import { NextResponse } from "next/server";
import { requireRole, AuthError } from "@/lib/auth";
import { approveMarketRecommendation, RECOMMENDATION_APPROVER_ROLES } from "@/lib/junk/approve-recommendation";
import { ApprovalError } from "@/lib/junk/pricing-approval";
import { ForbiddenError, MarketNotFoundError } from "@/lib/market-access";

/**
 * Approve a market price recommendation — correction 2.
 *
 * POST /api/admin/junk/recommendations/[id]/approve (owner/admin only).
 * Writes the approved price into the market's PricingRule for the
 * recommendation's own service level and tier, atomically and audited. It does
 * not touch live payments or Stripe. Staging only until the owner authorises.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, [...RECOMMENDATION_APPROVER_ROLES]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { id } = await context.params;
  try {
    const result = await approveMarketRecommendation({ recommendationId: id, actingUserId: authed.userId, actingRole: authed.role });
    return NextResponse.json({ approved: true, ...result });
  } catch (e) {
    if (e instanceof ApprovalError) return NextResponse.json({ error: e.message }, { status: e.httpStatus });
    if (e instanceof ForbiddenError || e instanceof MarketNotFoundError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
