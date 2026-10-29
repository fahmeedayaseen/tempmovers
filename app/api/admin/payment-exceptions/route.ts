import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";

/**
 * Audited payment exceptions — VASRUE Digital Media, 29 October 2026.
 *
 * POST /api/admin/payment-exceptions (admin, finance admin, super admin).
 *   { action: "create", entityType, entityId, kind, reason } or
 *   { action: "revoke", exceptionId, reason }
 *
 * The payment spec §3 allows credit-funded dispatch only under a separately
 * approved written policy and an audited owner authorisation, and §7 holds
 * releases without evidence. This is where those decisions are written down:
 * CREDIT_TERMS lets an unfunded job or load dispatch; EVIDENCE_WAIVER lets a
 * job settle without photos; RECEIPT_WAIVER is written by the disposal review.
 * Every create and revoke names who, when and why. Nothing is ever implied.
 */
const ROLES = ["ADMIN", "SUPER_ADMIN", "FINANCE_ADMIN"] as const;

const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    entityType: z.enum(["JOB", "LOAD", "FREIGHT_LOAD"]),
    entityId: z.string().min(1),
    kind: z.enum(["CREDIT_TERMS", "EVIDENCE_WAIVER"]),
    reason: z.string().trim().min(20, "Write down the policy and the reason (at least 20 characters).").max(1000),
  }),
  z.object({ action: z.literal("revoke"), exceptionId: z.string().min(1), reason: z.string().trim().min(5).max(1000) }),
]);

export async function POST(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ROLES as unknown as ("ADMIN")[]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  if (parsed.data.action === "revoke") {
    const ex = await prisma.paymentException.findUnique({ where: { id: parsed.data.exceptionId } });
    if (!ex) return NextResponse.json({ error: "Exception not found." }, { status: 404 });
    if (ex.revokedAt) return NextResponse.json({ error: "Already revoked." }, { status: 409 });
    const revoked = await prisma.paymentException.update({ where: { id: ex.id }, data: { revokedAt: new Date(), revokedByUserId: authed.userId } });
    await prisma.auditLog.create({ data: { actorId: authed.userId, action: "PAYMENT_EXCEPTION_REVOKED", entityType: "PaymentException", entityId: ex.id, details: { kind: ex.kind, entityType: ex.entityType, entityId: ex.entityId, reason: parsed.data.reason } } });
    return NextResponse.json({ exception: revoked });
  }

  const d = parsed.data;
  const exists = d.entityType === "JOB" ? await prisma.job.count({ where: { id: d.entityId } })
    : d.entityType === "LOAD" ? await prisma.carrierRoute.count({ where: { id: d.entityId } })
    : await prisma.freightLoad.count({ where: { id: d.entityId } });
  if (!exists) return NextResponse.json({ error: "No such job or load." }, { status: 404 });

  const created = await prisma.paymentException.create({ data: { entityType: d.entityType, entityId: d.entityId, kind: d.kind, reason: d.reason, authorizedByUserId: authed.userId } });
  await prisma.auditLog.create({ data: { actorId: authed.userId, action: "PAYMENT_EXCEPTION_CREATED", entityType: "PaymentException", entityId: created.id, details: { kind: d.kind, entityType: d.entityType, entityId: d.entityId, reason: d.reason } } });
  return NextResponse.json({ exception: created }, { status: 201 });
}
