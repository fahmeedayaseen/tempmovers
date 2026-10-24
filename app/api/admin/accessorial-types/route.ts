import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";

/**
 * Admin accessorial-type catalog (P0). GET lists types; POST creates one.
 * The catalog holds only stable, non-price config — pricing lives in
 * AccessorialMarketPrice. Admin/support and privileged admins may read;
 * creating/editing the catalog is ADMIN+ (SUPPORT excluded from writes).
 */
const createSchema = z.object({
  key: z.string().min(1).max(64).regex(/^[A-Z0-9_]+$/, "key must be UPPER_SNAKE"),
  label: z.string().min(1).max(120),
  serviceScope: z.array(z.enum(["MOVING", "LOCAL_BOX", "FREIGHT_BOX", "SEMI"])).min(1),
  pricingShape: z.enum(["FLAT", "PERCENTAGE", "HOURLY", "MILEAGE", "PER_ITEM", "PER_FLIGHT"]),
  platformShareMode: z.enum(["FLAT_CENTS", "PERCENT_OF_CHARGE"]),
  platformShareValue: z.number().int().nonnegative(),
  platformCapCents: z.number().int().nonnegative().nullable().optional(),
  isTaxable: z.boolean().optional(),
  taxRuleCode: z.string().max(64).nullable().optional(),
  ledgerCode: z.string().max(64).nullable().optional(),
  reportingCategory: z.string().max(64).nullable().optional(),
  requiresApproval: z.boolean().optional(),
  requiresEvidence: z.boolean().optional(),
  displayOrder: z.number().int().optional(),
});

const WRITE_ROLES = ["ADMIN", "FINANCE_ADMIN", "SUPER_ADMIN"] as const;
const READ_ROLES = ["ADMIN", "SUPPORT", "FINANCE_ADMIN", "SUPER_ADMIN"] as const;

export async function GET(request: Request) {
  try {
    await requireRole(request, READ_ROLES as unknown as ("ADMIN")[]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const types = await prisma.accessorialType.findMany({ orderBy: [{ displayOrder: "asc" }, { label: "asc" }] });
  return NextResponse.json({ types });
}

export async function POST(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, WRITE_ROLES as unknown as ("ADMIN")[]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const parsed = createSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  if (parsed.data.pricingShape === "PERCENTAGE" && parsed.data.platformShareMode === "FLAT_CENTS") {
    // allowed, but note: for PERCENTAGE the customerRate is a percent — a flat
    // platform cut is fine; no restriction, just documented.
  }

  try {
    const type = await prisma.accessorialType.create({ data: { ...parsed.data } });
    await prisma.auditLog.create({ data: { actorId: authed.userId, action: "ACCESSORIAL_TYPE_CREATED", entityType: "AccessorialType", entityId: type.id, details: { key: type.key } } });
    return NextResponse.json({ type }, { status: 201 });
  } catch (e) {
    // Unique key collision.
    if (typeof e === "object" && e && "code" in e && (e as { code?: string }).code === "P2002") {
      return NextResponse.json({ error: "An accessorial with that key already exists." }, { status: 409 });
    }
    throw e;
  }
}
