import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";

/**
 * Agreement acknowledgment (gap contract #7). A carrier acknowledges/signs a
 * required agreement (e.g. DISPATCH). Records signedAt + signer name and marks
 * it active. BROKER_CARRIER agreements remain gated elsewhere (dormant until
 * authority); this endpoint records the acknowledgment, it does not enable
 * brokerage. Carrier-scoped by ownerUserId.
 */
const schema = z.object({
  agreementType: z.string().min(1).max(60),
  version: z.string().max(40).optional(),
  signedByName: z.string().min(1).max(200),
  documentId: z.string().optional(),
});

export async function POST(request: Request) {
  let authed;
  try { authed = await requireRole(request, ["CARRIER", "ADMIN", "SUPER_ADMIN"] as unknown as ("ADMIN")[]); }
  catch (e) { if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; }

  const carrier = await prisma.carrier.findUnique({ where: { ownerUserId: authed.userId }, select: { id: true } });
  if (!carrier) return NextResponse.json({ error: "No carrier profile." }, { status: 404 });

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const d = parsed.data;

  // Idempotent-ish: if an active agreement of this type+version exists, return it.
  const existing = await prisma.carrierAgreement.findFirst({ where: { carrierId: carrier.id, agreementType: d.agreementType, version: d.version ?? null, active: true } });
  if (existing) return NextResponse.json({ agreement: existing, alreadyAcknowledged: true });

  const agreement = await prisma.carrierAgreement.create({
    data: { carrierId: carrier.id, agreementType: d.agreementType, version: d.version, signedByName: d.signedByName, signedAt: new Date(), documentId: d.documentId, active: true },
  });
  return NextResponse.json({ agreement }, { status: 201 });
}
