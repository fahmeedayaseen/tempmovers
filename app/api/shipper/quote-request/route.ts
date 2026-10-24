import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { isBrokerageCapabilityEnabled } from "@/lib/compliance/service-separation";

/**
 * Shipper quote request. Behavior depends on the brokerage gate:
 *  - When directShipperQuoting is DISABLED (dormant), this creates a
 *    NON-BINDING request-for-contact only. It does NOT create a binding broker
 *    quote, reserve capacity, or book freight. The shipper is told a rep will
 *    follow up.
 *  - When enabled (future), the same endpoint may create a real quote/load.
 * Either way the shipper only ever sees the customer transportation price.
 */
const SHIPPER_ROLES = ["CUSTOMER", "ADMIN", "SUPER_ADMIN"] as const;

const schema = z.object({
  originCity: z.string().max(120).optional(), originState: z.string().max(2).optional(),
  destinationCity: z.string().max(120).optional(), destinationState: z.string().max(2).optional(),
  equipmentType: z.string().max(60).optional(),
  commodity: z.string().max(200).optional(),
  weightLbs: z.number().int().positive().optional(),
  palletCount: z.number().int().nonnegative().optional(),
  pickupDate: z.string().optional(), deliveryDate: z.string().optional(),
  notes: z.string().max(2000).optional(),
});

export async function POST(request: Request) {
  let authed;
  try { authed = await requireRole(request, SHIPPER_ROLES as unknown as ("ADMIN")[]); }
  catch (e) { if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; }

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const quotingEnabled = await isBrokerageCapabilityEnabled("directShipperQuoting");

  if (!quotingEnabled) {
    // Dormant: record a request-for-contact only. No binding quote, no booking,
    // no capacity reservation.
    const req = await prisma.shipperQuoteRequest.create({
      data: { shipperUserId: authed.userId, ...parsed.data, status: "PENDING_CONTACT" },
    }).catch(() => null);
    return NextResponse.json({
      binding: false,
      status: "PENDING_CONTACT",
      requestId: req?.id ?? null,
      message: "Thanks — direct online quoting isn't available yet. Your request has been received and a representative will follow up.",
    });
  }

  // Enabled path (future): a real quote/load would be created here through the
  // gated load-creation flow. Intentionally not implemented while dormant.
  return NextResponse.json({ binding: false, status: "PENDING_CONTACT", message: "Quote request received." });
}
