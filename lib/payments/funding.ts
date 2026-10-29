import type Stripe from "stripe";
import { NextResponse } from "next/server";
import type { FundingAttempt, FundingEntityType, FundingState, Prisma, PrismaClient } from "@prisma/client";
import { prisma as defaultClient } from "@/lib/db";
import { stripe } from "@/lib/stripe";
import { LEGACY_POLICY_VERSION, PAYMENT_POLICY_VERSION } from "@/lib/payments/policy";

// ---------------------------------------------------------------------------
// Funding gate — VASRUE Digital Media, 29 October 2026.
//
// Carl's pay-before-dispatch work order, Correction A, and the payment spec
// §2–§4. The full approved amount is collected before any crew is dispatched
// or any service starts, on every customer-paid service.
//
//   fundedForScope = an approved quote exists
//                AND collected − refunds − refunds pending − disputed/returned
//                    covers that quote plus every paid change order
//                AND the payment method is ready (ACH: funds available)
//
// An authorisation, a pending ACH debit, a browser success page or a client
// "paid" flag never counts. Every dispatch and service-start route calls
// assertFundedForScope() on the server, after re-reading Stripe, so a stale
// worker screen cannot start an unfunded job. Job.paymentStatus stays as a
// display field; nothing here trusts it for a dispatch decision except on a
// legacy job booked before this policy, where it is all there is.
// ---------------------------------------------------------------------------

type Client = PrismaClient | Prisma.TransactionClient;

export type FundingRef = { type: FundingEntityType; id: string };

export type FundingLabel =
  | "PAID"
  | "PAYMENT_PENDING"
  | "ACTION_REQUIRED"
  | "PROCESSING"
  | "FAILED"
  | "REFUNDED"
  | "DISPUTED"
  | "CREDIT_TERMS";

export type FundingEvaluation = {
  ref: FundingRef;
  funded: boolean;
  label: FundingLabel;
  policyVersion: string;
  requiredCents: number;
  collectedCents: number;
  refundedCents: number;
  disputedCents: number;
  unavailableCents: number;
  availableCents: number;
  shortfallCents: number;
  creditTermsExceptionId: string | null;
  reasons: string[];
  attempts: { id: string; purpose: string; state: FundingState; amountCents: number; collectedCents: number; refundedCents: number; method: string | null }[];
};

export class FundingGateError extends Error {
  readonly status = 409;
  readonly code = "PAYMENT_NOT_COLLECTED";
  constructor(public readonly evaluation: FundingEvaluation, action: string) {
    super(
      `Payment has not been collected in full for this ${evaluation.ref.type === "JOB" ? "job" : "load"}, so it cannot be ${action} yet. ` +
      (evaluation.reasons[0] ?? "Collect the full amount first."),
    );
  }
}

/** The 409 every gated route returns. */
export function fundingGateResponse(e: FundingGateError) {
  return NextResponse.json(
    { error: e.message, code: e.code, funding: { label: e.evaluation.label, requiredCents: e.evaluation.requiredCents, availableCents: e.evaluation.availableCents, reasons: e.evaluation.reasons } },
    { status: e.status },
  );
}

// ---------------------------------------------------------------------------
// Stripe → FundingAttempt
// ---------------------------------------------------------------------------

const AWAITING_CUSTOMER: ReadonlySet<string> = new Set(["requires_action", "requires_confirmation"]);

/** Maps a PaymentIntent (and its charge) to a funding state. Authorised-only is UNPAID by design. */
export function fundingStateFromIntent(pi: Pick<Stripe.PaymentIntent, "status" | "amount_received" | "last_payment_error">, charge: Pick<Stripe.Charge, "amount_refunded" | "refunded" | "disputed" | "payment_method_details"> | null): {
  state: FundingState; collectedCents: number; refundedCents: number; disputedCents: number; failureReason: string | null; method: string | null;
} {
  const method = charge?.payment_method_details?.type ?? null;
  if (pi.status === "succeeded") {
    const collected = pi.amount_received;
    const refunded = charge?.amount_refunded ?? 0;
    if (charge?.disputed) {
      return { state: method === "us_bank_account" ? "RETURNED" : "DISPUTED", collectedCents: collected, refundedCents: refunded, disputedCents: Math.max(0, collected - refunded), failureReason: null, method };
    }
    if (charge?.refunded || (refunded > 0 && refunded >= collected)) return { state: "REFUNDED", collectedCents: collected, refundedCents: refunded, disputedCents: 0, failureReason: null, method };
    if (refunded > 0) return { state: "PARTIALLY_REFUNDED", collectedCents: collected, refundedCents: refunded, disputedCents: 0, failureReason: null, method };
    return { state: "COLLECTED", collectedCents: collected, refundedCents: 0, disputedCents: 0, failureReason: null, method };
  }
  if (pi.status === "processing") return { state: "PROCESSING", collectedCents: 0, refundedCents: 0, disputedCents: 0, failureReason: null, method };
  if (AWAITING_CUSTOMER.has(pi.status)) return { state: "ACTION_REQUIRED", collectedCents: 0, refundedCents: 0, disputedCents: 0, failureReason: null, method };
  if (pi.status === "canceled") return { state: "CANCELED", collectedCents: 0, refundedCents: 0, disputedCents: 0, failureReason: null, method };
  if (pi.status === "requires_capture") return { state: "UNPAID", collectedCents: 0, refundedCents: 0, disputedCents: 0, failureReason: "Authorised only; not collected.", method };
  // requires_payment_method: either never tried, or the last try failed.
  const err = pi.last_payment_error?.message ?? null;
  return { state: err ? "FAILED" : "UNPAID", collectedCents: 0, refundedCents: 0, disputedCents: 0, failureReason: err, method };
}

/**
 * Re-reads one PaymentIntent from Stripe and writes the truth onto its
 * FundingAttempt. Safe to call any number of times, in any order: it only
 * ever records what Stripe currently says. Returns null when the intent is
 * not a funding intent.
 */
export async function syncFundingAttempt(paymentIntentId: string, client: Client = defaultClient): Promise<FundingAttempt | null> {
  const attempt = await client.fundingAttempt.findUnique({ where: { stripePaymentIntentId: paymentIntentId } });
  if (!attempt) return null;

  const pi = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ["latest_charge.balance_transaction"] });
  const charge = typeof pi.latest_charge === "object" && pi.latest_charge ? pi.latest_charge : null;
  const mapped = fundingStateFromIntent(pi, charge);
  const bt = charge && typeof charge.balance_transaction === "object" && charge.balance_transaction ? charge.balance_transaction : null;

  const updated = await client.fundingAttempt.update({
    where: { id: attempt.id },
    data: {
      state: mapped.state,
      collectedCents: mapped.collectedCents,
      refundedCents: mapped.refundedCents,
      disputedCents: mapped.disputedCents,
      failureReason: mapped.failureReason,
      paymentMethodType: mapped.method ?? attempt.paymentMethodType,
      stripeChargeId: charge?.id ?? attempt.stripeChargeId,
      collectedAt: mapped.collectedCents > 0 ? attempt.collectedAt ?? new Date() : attempt.collectedAt,
      fundsAvailableAt: bt?.available_on ? new Date(bt.available_on * 1000) : attempt.fundsAvailableAt,
      lastSyncedAt: new Date(),
    },
  });

  if (updated.purpose === "CHANGE_ORDER" && updated.changeOrderId && updated.collectedCents >= updated.amountCents && updated.state === "COLLECTED") {
    const paid = await client.changeOrder.updateMany({
      where: { id: updated.changeOrderId, status: { in: ["PROPOSED", "ACCEPTED"] } },
      data: { status: "PAID", paidAt: new Date() },
    });
    // A paid extra helper opens one more helper seat on the junk job, once.
    if (paid.count > 0 && updated.entityType === "JOB") {
      const order = await client.changeOrder.findUnique({ where: { id: updated.changeOrderId }, select: { kind: true } });
      if (order?.kind === "EXTRA_HELPER") {
        const detail = await client.junkRemovalDetail.findUnique({ where: { jobId: updated.entityId }, select: { helpersRequired: true } });
        if (detail && detail.helpersRequired < 2) {
          await client.junkRemovalDetail.update({ where: { jobId: updated.entityId }, data: { helpersRequired: { increment: 1 } } });
          await client.job.update({ where: { id: updated.entityId }, data: { moversRequired: { increment: 1 } } });
          await client.job.updateMany({ where: { id: updated.entityId, status: "CONFIRMED" }, data: { status: "PARTIALLY_FILLED" } });
        }
      }
    }
  }
  return updated;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

const RESYNC_AFTER_MS = 60_000;

async function legacyFallback(ref: FundingRef, client: Client): Promise<{ required: number; collected: number; reason: string | null } | null> {
  if (ref.type === "JOB") {
    const job = await client.job.findUnique({ where: { id: ref.id }, select: { estimatedTotalCents: true, paymentStatus: true, capturedAmountCents: true } });
    if (!job) return null;
    if (job.paymentStatus === "CAPTURED" || job.paymentStatus === "PARTIALLY_REFUNDED") {
      return { required: job.estimatedTotalCents, collected: job.capturedAmountCents ?? job.estimatedTotalCents, reason: null };
    }
    return { required: job.estimatedTotalCents, collected: 0, reason: job.paymentStatus === "AUTHORIZED" ? "The card is only authorised. Collect the payment before dispatch." : "No payment has been collected." };
  }
  if (ref.type === "LOAD") {
    const load = await client.carrierRoute.findUnique({ where: { id: ref.id }, select: { customerTotalCents: true, grossCarrierCents: true, platformFeeCents: true, accessorialsCents: true, paymentStatus: true } });
    if (!load) return null;
    const total = load.customerTotalCents || load.grossCarrierCents + load.platformFeeCents + (load.accessorialsCents || 0);
    if (load.paymentStatus === "CAPTURED") return { required: total, collected: total, reason: null };
    return { required: total, collected: 0, reason: load.paymentStatus === "AUTHORIZED" ? "The card is only authorised. Collect the payment before dispatch." : "No payment has been collected." };
  }
  const freight = await client.freightLoad.findUnique({ where: { id: ref.id }, select: { customerTotalCents: true, invoices: { where: { status: "PAID" }, select: { totalCents: true } } } });
  if (!freight) return null;
  const paid = freight.invoices.reduce((a, i) => a + i.totalCents, 0);
  return { required: freight.customerTotalCents, collected: paid, reason: paid >= freight.customerTotalCents && freight.customerTotalCents > 0 ? null : "The shipper invoice has not been paid. Invoices are a way to pay, not credit." };
}

export async function evaluateFunding(ref: FundingRef, opts: { refresh?: boolean; client?: Client; now?: Date } = {}): Promise<FundingEvaluation> {
  const client = opts.client ?? defaultClient;
  const now = opts.now ?? new Date();
  const reasons: string[] = [];

  const exception = await client.paymentException.findFirst({
    where: { entityType: ref.type, entityId: ref.id, kind: "CREDIT_TERMS", revokedAt: null },
    orderBy: { createdAt: "desc" },
  });

  let attempts = await client.fundingAttempt.findMany({ where: { entityType: ref.type, entityId: ref.id }, orderBy: { createdAt: "asc" } });
  if (opts.refresh && attempts.length > 0) {
    const stale = attempts.filter((a) => !a.lastSyncedAt || now.getTime() - a.lastSyncedAt.getTime() > RESYNC_AFTER_MS);
    for (const a of stale) await syncFundingAttempt(a.stripePaymentIntentId, client);
    if (stale.length) attempts = await client.fundingAttempt.findMany({ where: { entityType: ref.type, entityId: ref.id }, orderBy: { createdAt: "asc" } });
  }

  const summary = attempts.map((a) => ({ id: a.id, purpose: a.purpose, state: a.state, amountCents: a.amountCents, collectedCents: a.collectedCents, refundedCents: a.refundedCents, method: a.paymentMethodType }));

  // Legacy: booked before pay-before-dispatch, so no funding attempts exist.
  if (attempts.length === 0) {
    const legacy = await legacyFallback(ref, client);
    const required = legacy?.required ?? 0;
    const collected = legacy?.collected ?? 0;
    if (legacy?.reason) reasons.push(legacy.reason);
    const fundedByMoney = required > 0 && collected >= required;
    const funded = fundedByMoney || !!exception;
    if (!fundedByMoney && exception) reasons.unshift(`Dispatch allowed under an audited credit-terms exception: ${exception.reason}`);
    return {
      ref, funded, label: fundedByMoney ? "PAID" : exception ? "CREDIT_TERMS" : "PAYMENT_PENDING",
      policyVersion: LEGACY_POLICY_VERSION, requiredCents: required, collectedCents: collected, refundedCents: 0, disputedCents: 0,
      unavailableCents: 0, availableCents: collected, shortfallCents: Math.max(0, required - collected),
      creditTermsExceptionId: exception?.id ?? null, reasons, attempts: summary,
    };
  }

  // Required scope: the latest quote plus every paid change order.
  const quote = await client.quoteVersion.findFirst({ where: { entityType: ref.type, entityId: ref.id }, orderBy: { version: "desc" } });
  const paidChangeOrders = await client.changeOrder.aggregate({ where: { entityType: ref.type, entityId: ref.id, status: "PAID" }, _sum: { deltaCents: true } });
  let requiredCents = (quote?.totalCents ?? 0) + (paidChangeOrders._sum.deltaCents ?? 0);
  if (!quote) {
    const legacy = await legacyFallback(ref, client);
    requiredCents = (legacy?.required ?? 0) + (paidChangeOrders._sum.deltaCents ?? 0);
    reasons.push("No versioned quote on file; using the booking total.");
  }

  let collectedCents = 0, refundedCents = 0, disputedCents = 0, unavailableCents = 0;
  for (const a of attempts) {
    if (!["COLLECTED", "PARTIALLY_REFUNDED", "REFUNDED", "DISPUTED", "RETURNED"].includes(a.state)) continue;
    collectedCents += a.collectedCents;
    refundedCents += a.refundedCents;
    if (a.state === "DISPUTED" || a.state === "RETURNED") disputedCents += a.disputedCents;
    // ACH: success alone is not enough; the funds must be available (spec §4).
    if (a.paymentMethodType === "us_bank_account" && a.state === "COLLECTED" && (!a.fundsAvailableAt || a.fundsAvailableAt > now)) {
      unavailableCents += a.collectedCents - a.refundedCents;
    }
  }

  // Refunds already requested but not yet reflected on the charge are reserved.
  const pendingRefunds = await client.paymentRefund.aggregate({
    where: {
      status: { in: ["PROCESSING", "PENDING", "SUCCEEDED"] },
      paymentTransaction: ref.type === "JOB" ? { jobId: ref.id } : ref.type === "LOAD" ? { loadId: ref.id } : { id: "__none__" },
    },
    _sum: { amountCents: true },
  });
  const refundsOrReserved = Math.max(refundedCents, pendingRefunds._sum.amountCents ?? 0);

  const availableCents = collectedCents - refundsOrReserved - disputedCents - unavailableCents;
  const fundedByMoney = requiredCents > 0 && availableCents >= requiredCents;

  const latest = attempts[attempts.length - 1];
  let label: FundingLabel = fundedByMoney ? "PAID" : "PAYMENT_PENDING";
  if (!fundedByMoney) {
    if (disputedCents > 0) { label = "DISPUTED"; reasons.push("A payment on this booking is disputed or was returned by the bank."); }
    else if (latest.state === "PROCESSING" || unavailableCents > 0) { label = "PROCESSING"; reasons.push("The payment is still processing. Bank payments must clear before dispatch."); }
    else if (latest.state === "ACTION_REQUIRED") { label = "ACTION_REQUIRED"; reasons.push("The customer still needs to finish confirming the payment."); }
    else if (latest.state === "FAILED") { label = "FAILED"; reasons.push(`The last payment attempt failed${latest.failureReason ? `: ${latest.failureReason}` : "."}`); }
    else if (refundsOrReserved > 0 && collectedCents > 0) { label = "REFUNDED"; reasons.push("The payment has been refunded, in full or in part."); }
    else reasons.push("No payment has been collected yet.");
    if (requiredCents > 0 && availableCents > 0 && availableCents < requiredCents) reasons.push(`Collected ${availableCents} of ${requiredCents} cents.`);
  }

  const funded = fundedByMoney || !!exception;
  if (!fundedByMoney && exception) { label = "CREDIT_TERMS"; reasons.unshift(`Dispatch allowed under an audited credit-terms exception: ${exception.reason}`); }

  return {
    ref, funded, label, policyVersion: PAYMENT_POLICY_VERSION, requiredCents, collectedCents, refundedCents: refundsOrReserved, disputedCents,
    unavailableCents, availableCents, shortfallCents: Math.max(0, requiredCents - availableCents),
    creditTermsExceptionId: exception?.id ?? null, reasons, attempts: summary,
  };
}

/**
 * The gate. Re-reads Stripe, then throws FundingGateError unless the job or
 * load is funded for its approved scope. Call it on the server at every
 * dispatch and service-start path.
 */
export async function assertFundedForScope(ref: FundingRef, ctx: { action: string; actorUserId?: string | null; client?: Client }): Promise<FundingEvaluation> {
  const client = ctx.client ?? defaultClient;
  let evaluation: FundingEvaluation;
  try {
    evaluation = await evaluateFunding(ref, { refresh: true, client });
  } catch {
    // Stripe unreachable: decide on what we last recorded, never on nothing.
    evaluation = await evaluateFunding(ref, { refresh: false, client });
  }
  if (!evaluation.funded) {
    await client.auditLog.create({
      data: {
        actorId: ctx.actorUserId ?? null, action: "FUNDING_GATE_BLOCKED", entityType: ref.type === "JOB" ? "Job" : ref.type === "LOAD" ? "CarrierRoute" : "FreightLoad", entityId: ref.id,
        details: { attemptedAction: ctx.action, label: evaluation.label, requiredCents: evaluation.requiredCents, availableCents: evaluation.availableCents, reasons: evaluation.reasons },
      },
    }).catch(() => undefined);
    throw new FundingGateError(evaluation, ctx.action);
  }
  return evaluation;
}

// ---------------------------------------------------------------------------
// Quotes and funding attempts
// ---------------------------------------------------------------------------

/** Writes the next immutable quote version for a job or load and returns it. */
export async function recordQuoteVersion(ref: FundingRef, input: { totalCents: number; lines: Prisma.InputJsonValue; plan?: Prisma.InputJsonValue; createdByUserId?: string | null; accepted?: boolean }, client: Client = defaultClient) {
  const last = await client.quoteVersion.findFirst({ where: { entityType: ref.type, entityId: ref.id }, orderBy: { version: "desc" }, select: { version: true } });
  return client.quoteVersion.create({
    data: {
      entityType: ref.type, entityId: ref.id, version: (last?.version ?? 0) + 1, policyVersion: PAYMENT_POLICY_VERSION,
      totalCents: input.totalCents, lines: input.lines, plan: input.plan, createdByUserId: input.createdByUserId ?? null,
      acceptedAt: input.accepted ? new Date() : null, acceptedByUserId: input.accepted ? input.createdByUserId ?? null : null,
    },
  });
}

/** The latest quote, creating version 1 from the booking's own totals if the booking predates quotes. */
export async function ensureQuoteVersion(ref: FundingRef, fallback: { totalCents: number; lines: Prisma.InputJsonValue; plan?: Prisma.InputJsonValue }, actorUserId: string | null, client: Client = defaultClient) {
  const existing = await client.quoteVersion.findFirst({ where: { entityType: ref.type, entityId: ref.id }, orderBy: { version: "desc" } });
  if (existing && existing.totalCents === fallback.totalCents) {
    if (!existing.acceptedAt) {
      return client.quoteVersion.update({ where: { id: existing.id }, data: { acceptedAt: new Date(), acceptedByUserId: actorUserId } });
    }
    return existing;
  }
  return recordQuoteVersion(ref, { ...fallback, createdByUserId: actorUserId, accepted: true }, client);
}

/** Payment method types allowed for collecting a booking (spec §3–§4): cards; ACH only if switched on and there is lead time. */
export function fundingPaymentMethodTypes(opts: { achEnabled: boolean; startsAt: Date | null; now?: Date }): string[] {
  const now = opts.now ?? new Date();
  const ACH_MIN_LEAD_MS = 7 * 24 * 60 * 60 * 1000;
  if (opts.achEnabled && opts.startsAt && opts.startsAt.getTime() - now.getTime() >= ACH_MIN_LEAD_MS) return ["card", "us_bank_account"];
  return ["card"];
}

/** Route helper: null when the gate passes, otherwise the 409 to return. */
export async function blockUnlessFunded(ref: FundingRef, ctx: { action: string; actorUserId?: string | null }): Promise<NextResponse | null> {
  try {
    await assertFundedForScope(ref, ctx);
    return null;
  } catch (e) {
    if (e instanceof FundingGateError) return fundingGateResponse(e);
    throw e;
  }
}

/**
 * The customer charge a worker transfer can be tied to (separate charges and
 * transfers): the funding payment with the most money left on it, used only
 * when it can cover the transfer. Otherwise the transfer draws on the
 * platform's available balance as before.
 */
export async function sourceChargeFor(ref: FundingRef, amountCents: number, client: Client = defaultClient): Promise<string | null> {
  const attempts = await client.fundingAttempt.findMany({
    where: { entityType: ref.type, entityId: ref.id, stripeChargeId: { not: null }, state: { in: ["COLLECTED", "PARTIALLY_REFUNDED"] } },
    select: { stripeChargeId: true, collectedCents: true, refundedCents: true },
  });
  const best = attempts.map((a) => ({ id: a.stripeChargeId, net: a.collectedCents - a.refundedCents })).sort((a, b) => b.net - a.net)[0];
  return best && best.net >= amountCents ? best.id : null;
}
