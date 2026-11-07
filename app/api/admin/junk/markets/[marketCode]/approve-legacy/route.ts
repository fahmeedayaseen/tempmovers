import { NextResponse } from "next/server";
import { requireRole, AuthError } from "@/lib/auth";
import { approveLegacyFullServicePricing, RECOMMENDATION_APPROVER_ROLES } from "@/lib/junk/approve-recommendation";
import { ApprovalError } from "@/lib/junk/pricing-approval";
import { ForbiddenError, MarketNotFoundError } from "@/lib/market-access";

/**
 * Controlled legacy-pricing approval — correction item 2.
 *
 * POST /api/admin/junk/markets/[marketCode]/approve-legacy (owner/admin, market
 * authorized). Blesses a market's pre-existing top-level junk prices as
 * owner-approved Full-Service rates (documented marker + audit). It changes no
 * price value and no booking snapshot. Staging only.
 */
export async function POST(request: Request, context: { params: Promise<{ marketCode: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, [...RECOMMENDATION_APPROVER_ROLES]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { marketCode } = await context.params;
  try {
    const result = await approveLegacyFullServicePricing({ marketCode, actingUserId: authed.userId, actingRole: authed.role });
    return NextResponse.json({ approved: true, ...result });
  } catch (e) {
    if (e instanceof ApprovalError) return NextResponse.json({ error: e.message }, { status: e.httpStatus });
    if (e instanceof ForbiddenError || e instanceof MarketNotFoundError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
