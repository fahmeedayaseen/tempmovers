import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { DEFAULT_POLICY_MARKET_CODE, paymentPolicyUpdateSchema, resolvePaymentPolicy } from "@/lib/payments/policy";

/**
 * Payment policy settings — VASRUE Digital Media, 29 October 2026.
 *
 * GET   /api/admin/payment-policy?marketCode=INDY — the values in force for a
 *       market (its own row, else US-DEFAULT, else the built-in proposals) and
 *       whether Carl has approved them.
 * PATCH /api/admin/payment-policy — set any of them for a market without a
 *       deploy: junk platform fee (bps), helper rate, minimum and increment,
 *       hauler earnings floor and truck allowance, disposal estimates and
 *       special-item adders, receipt auto-approve limit, review window, ACH.
 *       markCarlApproved records Carl's sign-off (payment spec §9). Changes
 *       apply to new quotes only; booked jobs keep their snapshot.
 */
const ADMIN_ROLES = ["ADMIN", "SUPER_ADMIN", "FINANCE_ADMIN"] as const;

export async function GET(request: Request) {
  try {
    await requireRole(request, ADMIN_ROLES as unknown as ("ADMIN")[]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const marketCode = new URL(request.url).searchParams.get("marketCode") || DEFAULT_POLICY_MARKET_CODE;
  const policy = await resolvePaymentPolicy(marketCode);
  return NextResponse.json({ policy, approvedByCarl: policy.carlApprovedAt !== null });
}

export async function PATCH(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ADMIN_ROLES as unknown as ("ADMIN")[]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const parsed = paymentPolicyUpdateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const { marketCode, markCarlApproved, ...values } = parsed.data;

  const before = await prisma.paymentPolicyConfig.findUnique({ where: { marketCode } });
  const data: Prisma.PaymentPolicyConfigUncheckedCreateInput = {
    marketCode,
    ...values,
    ...(values.disposalEstimatesCents && { disposalEstimatesCents: { ...((before?.disposalEstimatesCents as object) ?? {}), ...values.disposalEstimatesCents } }),
    ...(values.disposalAddersCents && { disposalAddersCents: { ...((before?.disposalAddersCents as object) ?? {}), ...values.disposalAddersCents } }),
    updatedByUserId: authed.userId,
    ...(markCarlApproved === true && { carlApprovedAt: new Date() }),
    ...(markCarlApproved === false && { carlApprovedAt: null }),
  };
  const { marketCode: _m, ...update } = data;
  const saved = await prisma.paymentPolicyConfig.upsert({ where: { marketCode }, create: data, update });
  await prisma.auditLog.create({ data: { actorId: authed.userId, action: "PAYMENT_POLICY_UPDATED", entityType: "PaymentPolicyConfig", entityId: saved.id, details: { marketCode, changed: values as Prisma.InputJsonObject, markCarlApproved: markCarlApproved ?? null } } });
  return NextResponse.json({ policy: await resolvePaymentPolicy(marketCode) });
}
