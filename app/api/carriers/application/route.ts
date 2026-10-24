import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";

/**
 * Carrier application (self-service). A CARRIER user creates/updates their own
 * carrier company profile. Rule #1: a new application starts at
 * APPLICATION_STARTED and CANNOT self-advance to APPROVED/ACTIVE — only an
 * admin review route can move it forward. This route never sets a
 * load-eligible status.
 *
 * Rule #5: no ACH/bank numbers are accepted or stored here — only a payment
 * preference and (later) a provider reference set via the payment provider.
 *
 * Carrier recruitment is allowed while freight brokerage is disabled (rule #7),
 * so this route is NOT behind the brokerage gate.
 */
const applicationSchema = z.object({
  legalBusinessName: z.string().min(1).max(200),
  dbaName: z.string().max(200).optional(),
  contactName: z.string().max(200).optional(),
  contactEmail: z.string().email().optional(),
  contactPhone: z.string().max(40).optional(),
  businessAddress: z.string().max(500).optional(),
  ein: z.string().max(20).optional(),
  dotNumber: z.string().max(20).optional(),
  mcNumber: z.string().max(20).optional(),
  homeTerminal: z.string().max(200).optional(),
  operatingRadiusMiles: z.number().int().positive().max(3000).optional(),
  numberOfTrucks: z.number().int().nonnegative().optional(),
  paymentPreference: z.enum(["DIRECT_DEPOSIT", "FACTORING", "QUICK_PAY"]).optional(),
  factoringCompanyName: z.string().max(200).optional(),
  marketId: z.string().optional(),
  // Explicitly NO bankAccount/routingNumber fields — those never touch this DB.
});

export async function POST(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["CARRIER", "ADMIN", "SUPER_ADMIN"] as unknown as ("ADMIN")[]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const parsed = applicationSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const data = parsed.data;

  // Duplicate DOT/MC prevention (also enforced by DB unique constraints; checked
  // here for a clean 409 pointing at the conflict).
  if (data.dotNumber || data.mcNumber) {
    const clash = await prisma.carrier.findFirst({
      where: {
        AND: [
          { ownerUserId: { not: authed.userId } },
          { OR: [data.dotNumber ? { dotNumber: data.dotNumber } : {}, data.mcNumber ? { mcNumber: data.mcNumber } : {}].filter((o) => Object.keys(o).length) },
        ],
      },
      select: { id: true },
    });
    if (clash) return NextResponse.json({ error: "A carrier with this DOT or MC number already exists." }, { status: 409 });
  }

  // Upsert the caller's own carrier. Status is NEVER set from the client — a
  // new record is APPLICATION_STARTED; existing status is preserved.
  const existing = await prisma.carrier.findUnique({ where: { ownerUserId: authed.userId } });
  const carrier = existing
    ? await prisma.carrier.update({ where: { ownerUserId: authed.userId }, data: { ...data } })
    : await prisma.carrier.create({ data: { ...data, ownerUserId: authed.userId, status: "APPLICATION_STARTED" } });

  if (!existing) {
    await prisma.carrierStatusEvent.create({
      data: { carrierId: carrier.id, fromStatus: null, toStatus: "APPLICATION_STARTED", reason: "Application created", changedById: authed.userId },
    });
  }

  return NextResponse.json({ carrier }, { status: existing ? 200 : 201 });
}

export async function GET(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["CARRIER", "ADMIN", "SUPER_ADMIN"] as unknown as ("ADMIN")[]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const carrier = await prisma.carrier.findUnique({
    where: { ownerUserId: authed.userId },
    include: { documents: true, insurancePolicies: true, equipment: true, lanes: true, agreements: true },
  });
  return NextResponse.json({ carrier });
}
