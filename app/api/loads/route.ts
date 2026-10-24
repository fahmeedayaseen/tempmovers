import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { SANITIZED_LOAD_SELECT } from "@/lib/access/sanitize-load";
import { postLoadSchema } from "@/lib/loads/post-load-schema";
import { createCarrierRouteLoad } from "@/lib/loads/create-load";

// Fields that are safe to hand back on the public/unauthenticated load board.
// Deliberately excludes: exact addresses, shipper contact, commodity detail,
// access codes, private documents, internal margin, driver contact info.
const PUBLIC_LOAD_SELECT = SANITIZED_LOAD_SELECT;

const querySchema = z.object({
  equipment: z.enum(["BOX_TRUCK", "SEMI_TRACTOR", "SEMI_TRACTOR_TRAILER", "all"]).optional(),
  originZip: z.string().optional(),
  routeType: z.enum(["local", "regional", "all"]).optional(),
  minGrossCents: z.coerce.number().int().nonnegative().optional(),
  liftgate: z.coerce.boolean().optional(),
  cdl: z.coerce.boolean().optional(),
  pickupDate: z.string().optional(),
});

type PublicLoadRow = {
  id: string; title: string;
  visibility: "PUBLIC_PREVIEW" | "VERIFIED_CARRIERS_ONLY" | "PREFERRED_NETWORK" | "PRIVATE_CONFIDENTIAL";
  status: string;
  originCity: string; originState: string; originZip: string | null;
  destinationCity: string; destinationState: string;
  equipmentType: string; pickupDate: Date; estimatedHoursOrMiles: string;
  stopCount: number; liftgateRequired: boolean; cdlRequired: boolean; isLocalRoute: boolean;
  grossCarrierCents: number;
};

/**
 * Unauthenticated/public board. This endpoint must NEVER return anything except
 * PUBLIC_PREVIEW loads — even the stripped preview fields (lane, date, equipment,
 * pay) reveal a confidential shipment if a preferred/private load leaks through
 * here. Authenticated drivers with VERIFIED_CARRIERS_ONLY / PREFERRED_NETWORK
 * access use GET /api/driver/loads instead, which layers in worker-specific
 * eligibility (see that route for the authorization logic).
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const parsed = querySchema.safeParse(Object.fromEntries(searchParams));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const q = parsed.data;

  // P0-02: the public load board exposes brokered freight. While freight
  // brokerage is disabled platform-wide, this board must not surface broker
  // loads — return an empty "coming soon" board instead of leaking them.
  const { isBrokerageCapabilityEnabled } = await import("@/lib/compliance/service-separation");
  if (!(await isBrokerageCapabilityEnabled("loadPosting"))) {
    return NextResponse.json({ loads: [], comingSoon: true });
  }

  const where: Record<string, unknown> = {
    visibility: "PUBLIC_PREVIEW",
    status: { in: ["OPEN", "OFFER_RECEIVED"] },
  };
  if (q.equipment && q.equipment !== "all") where.equipmentType = q.equipment;
  if (q.originZip) where.originZip = q.originZip;
  if (q.routeType === "local") where.isLocalRoute = true;
  if (q.routeType === "regional") where.isLocalRoute = false;
  if (q.liftgate) where.liftgateRequired = true;
  if (q.cdl) where.cdlRequired = true;
  if (q.minGrossCents) where.grossCarrierCents = { gte: q.minGrossCents };
  if (q.pickupDate) {
    const day = new Date(q.pickupDate);
    where.pickupDate = { gte: day, lt: new Date(day.getTime() + 86400000) };
  }

  const loads: PublicLoadRow[] = await prisma.carrierRoute.findMany({
    where,
    select: PUBLIC_LOAD_SELECT,
    orderBy: { pickupDate: "asc" },
    take: 50,
  });

  // platformFeeCents is never selected/returned here — customer/shipper totals are
  // computed server-side from lib/pricing.ts, not trusted from anything client-supplied.
  return NextResponse.json({
    loads: loads.map((l) => ({ ...l, locked: false })),
  });
}



export async function POST(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["CUSTOMER", "ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const parsed = postLoadSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const input = parsed.data;

  // P0-01: posting a brokered load is a brokerage capability. Block it while
  // brokerage is disabled (throws 403 unless master + LOAD_POSTING both on).
  try {
    const { assertBrokerageAllowed } = await import("@/lib/compliance/service-separation");
    await assertBrokerageAllowed("loadPosting");
  } catch (e) {
    const status = (e as { status?: number }).status ?? 403;
    return NextResponse.json({ error: "Freight load posting is not currently available." }, { status });
  }

  // Delegate to the shared creation service — the single money path used by
  // both native posts and external-load imports, so pricing can't diverge.
  const result = await createCarrierRouteLoad({ input, postedByUserId: authed.userId, postedByRole: authed.role });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  await prisma.auditLog.create({
    data: { actorId: authed.userId, action: "LOAD_POSTED", entityType: "CarrierRoute", entityId: result.load.id },
  });
  return NextResponse.json({ load: result.load }, { status: 201 });
}
