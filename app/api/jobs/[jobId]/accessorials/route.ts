import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { applyAccessorial, applyError } from "@/lib/accessorials/apply";
import { requireMarketAccess, ForbiddenError, MarketNotFoundError } from "@/lib/market-access";

/**
 * Apply an accessorial to a moving job (P0). ADMIN/SUPPORT (or a later
 * worker-facing flow) proposes/applies a charge; the market comes from the
 * job so pricing resolves server-side. Moving jobs are ADD_TO_CUSTOMER, so
 * the customer funds the platform share — that split is applied downstream at
 * billing; here we just record the frozen charge.
 */
const schema = z.object({
  accessorialTypeId: z.string().cuid(),
  quantity: z.number().positive().default(1),
  status: z.enum(["PROPOSED", "APPROVED"]).optional(),
});

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["ADMIN", "SUPPORT", "FINANCE_ADMIN", "SUPER_ADMIN"] as unknown as ("ADMIN")[]);
  } catch (e) {
    if (e instanceof AuthError) return applyError(e.status, e.message);
    throw e;
  }
  const { jobId } = await context.params;
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return applyError(400, "Invalid request.");

  const job = await prisma.job.findUnique({ where: { id: jobId }, select: { id: true, marketId: true } });
  if (!job) return applyError(404, "Job not found.");

  // Admin acting on a job they don't own → enforce market access. Fail closed
  // if the job has no market (can't authorize an unscoped record).
  if (!job.marketId) return applyError(403, "This job has no market; cannot authorize accessorial changes.");
  try {
    await requireMarketAccess({ userId: authed.userId, marketId: job.marketId });
  } catch (e) {
    if (e instanceof ForbiddenError || e instanceof MarketNotFoundError) return applyError(e.status, e.message);
    throw e;
  }

  const result = await applyAccessorial({
    actorUserId: authed.userId,
    booking: { kind: "job", jobId: job.id, marketId: job.marketId },
    accessorialTypeId: parsed.data.accessorialTypeId,
    quantity: parsed.data.quantity,
    status: parsed.data.status,
  });
  if (!result.ok) return applyError(result.status, result.error);
  return Response.json({ accessorial: result.accessorial }, { status: 201 });
}
