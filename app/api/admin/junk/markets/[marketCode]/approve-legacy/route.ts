import { NextResponse } from "next/server";
import { z } from "zod";
import { requireRole, AuthError } from "@/lib/auth";
import { approveLegacyFullServicePricing, RECOMMENDATION_APPROVER_ROLES } from "@/lib/junk/approve-recommendation";
import { ApprovalError } from "@/lib/junk/pricing-approval";
import { ForbiddenError, MarketNotFoundError } from "@/lib/market-access";
import { JUNK_VOLUME_TIERS, JUNK_ITEM_CODES } from "@/lib/junk/pricing";

/**
 * Controlled legacy-pricing approval — correction round 5, item 2.
 *
 * POST /api/admin/junk/markets/[marketCode]/approve-legacy (owner/admin, market
 * authorized). The body carries the EXACT reviewed Full-Service rates being
 * authorized; they are validated (floor) and written explicitly into the
 * FULL_SERVICE slot with the values audited. No blanket approval. Staging only.
 */
const cents = z.number().int().positive().max(1_000_000);
const bodySchema = z.object({
  tiers: z.record(z.enum(JUNK_VOLUME_TIERS), cents).optional(),
  items: z.record(z.enum(JUNK_ITEM_CODES), cents).optional(),
}).refine((b) => (b.tiers && Object.keys(b.tiers).length) || (b.items && Object.keys(b.items).length), {
  message: "Specify at least one reviewed legacy rate (tiers and/or items).",
});

export async function POST(request: Request, context: { params: Promise<{ marketCode: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, [...RECOMMENDATION_APPROVER_ROLES]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { marketCode } = await context.params;
  try {
    const result = await approveLegacyFullServicePricing({ marketCode, actingUserId: authed.userId, actingRole: authed.role, rates: parsed.data });
    return NextResponse.json({ approved: true, ...result });
  } catch (e) {
    if (e instanceof ApprovalError) return NextResponse.json({ error: e.message }, { status: e.httpStatus });
    if (e instanceof ForbiddenError || e instanceof MarketNotFoundError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
