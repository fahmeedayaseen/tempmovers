import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { postLoadSchema } from "@/lib/loads/post-load-schema";
import { createCarrierRouteLoad } from "@/lib/loads/create-load";

/**
 * Import External Load (launch-enabling, no external API needed).
 *
 * Lets a dispatcher manually enter a load they accepted off an external board
 * (DAT, Truckstop, 123Loadboard) so it lives and settles inside TempMovers
 * exactly like an internal load. This is the bridge that lets freight earn
 * revenue at the Indianapolis launch WITHOUT waiting on live board-API
 * automation (that automation is a post-launch, flag-gated adapter — see
 * lib/integrations/freight-adapters.ts).
 *
 * Uses the SAME createCarrierRouteLoad() money path as POST /api/loads, so an
 * imported load prices identically to a native one — only the provenance
 * (sourceProvider + externalLoadId + MANUAL_IMPORT) differs. The unique
 * (sourceProvider, externalLoadId) constraint prevents importing twice.
 */
const importSchema = z.object({
  provider: z.enum(["DAT", "TRUCKSTOP", "LOADBOARD_123", "UBER_FREIGHT", "DIRECT_FREIGHT"]),
  externalLoadId: z.string().min(1).max(120),
  load: postLoadSchema,
});

const DISPATCH_ROLES = ["ADMIN", "SUPPORT", "FINANCE_ADMIN", "SUPER_ADMIN"] as const;

export async function POST(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, DISPATCH_ROLES as unknown as ("ADMIN")[]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const parsed = importSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const { provider, externalLoadId, load } = parsed.data;

  // P0-01: importing an external brokered load is a brokerage capability.
  // Blocked while brokerage is disabled (throws 403 unless master + LOAD_POSTING).
  try {
    const { assertBrokerageAllowed } = await import("@/lib/compliance/service-separation");
    await assertBrokerageAllowed("loadPosting");
  } catch (e) {
    const status = (e as { status?: number }).status ?? 403;
    return NextResponse.json({ error: "Freight load import is not currently available." }, { status });
  }

  // Dedupe (also enforced by the DB unique constraint; checked here for a
  // clean 409 rather than a raw constraint error).
  const existing = await prisma.carrierRoute.findFirst({
    where: { sourceProvider: provider, externalLoadId },
    select: { id: true },
  });
  if (existing) {
    return NextResponse.json({ error: "This external load has already been imported.", loadId: existing.id }, { status: 409 });
  }

  const result = await createCarrierRouteLoad({
    input: load,
    postedByUserId: authed.userId,
    postedByRole: authed.role,
    provenance: { sourceProvider: provider, externalLoadId },
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  await prisma.auditLog.create({
    data: { actorId: authed.userId, action: "EXTERNAL_LOAD_IMPORTED", entityType: "CarrierRoute", entityId: result.load.id,
      details: { provider, externalLoadId, serviceType: load.serviceType } },
  });

  return NextResponse.json({ load: result.load, provenance: { sourceProvider: provider, externalLoadId, externalSyncStatus: "MANUAL_IMPORT" } }, { status: 201 });
}
