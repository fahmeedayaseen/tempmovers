import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { applyAccessorial, applyError } from "@/lib/accessorials/apply";
import { requireMarketAccess, ForbiddenError, MarketNotFoundError } from "@/lib/market-access";

/**
 * Apply an accessorial to a freight load (P0). Market comes from the load's
 * originMarketId. Freight is DEDUCT_FROM_PROVIDER, so the carrier funds the
 * platform share — again applied downstream at settlement; here we record the
 * frozen charge and its provider/platform split.
 */
const schema = z.object({
  accessorialTypeId: z.string().cuid(),
  quantity: z.number().positive().default(1),
  status: z.enum(["PROPOSED", "APPROVED"]).optional(),
});

export async function POST(request: Request, context: { params: Promise<{ loadId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["ADMIN", "SUPPORT", "FINANCE_ADMIN", "SUPER_ADMIN"] as unknown as ("ADMIN")[]);
  } catch (e) {
    if (e instanceof AuthError) return applyError(e.status, e.message);
    throw e;
  }
  const { loadId } = await context.params;
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return applyError(400, "Invalid request.");

  const load = await prisma.carrierRoute.findUnique({ where: { id: loadId }, select: { id: true, originMarketId: true } });
  if (!load) return applyError(404, "Load not found.");

  // Admin acting on a load they don't own → enforce market access on the
  // load's origin market. Fail closed if the load has no origin market.
  if (!load.originMarketId) return applyError(403, "This load has no origin market; cannot authorize accessorial changes.");
  try {
    await requireMarketAccess({ userId: authed.userId, marketId: load.originMarketId });
  } catch (e) {
    if (e instanceof ForbiddenError || e instanceof MarketNotFoundError) return applyError(e.status, e.message);
    throw e;
  }

  const result = await applyAccessorial({
    actorUserId: authed.userId,
    booking: { kind: "load", loadId: load.id, marketId: load.originMarketId },
    accessorialTypeId: parsed.data.accessorialTypeId,
    quantity: parsed.data.quantity,
    status: parsed.data.status,
  });
  if (!result.ok) return applyError(result.status, result.error);
  return Response.json({ accessorial: result.accessorial }, { status: 201 });
}
