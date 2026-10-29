import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { onlyPodAcceptedLoads } from "@/lib/payments/settlement";
import { partitionByMarketAccess } from "@/lib/market-access";
import { verifyPreviewToken, computeBatchFingerprint } from "@/lib/settlements/preview-token";

const generateSchema = z.object({
  workerId: z.string().cuid(),
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime(),
  // Option 3 confirm-before-execute: the client must POST the preview first,
  // then re-submit with confirm:true. Guards against settling a batch the
  // admin hasn't reviewed (which may silently exclude skipped markets).
  confirm: z.literal(true),
  // Binds this confirmation to the exact batch the admin reviewed. The token
  // carries a fingerprint of the previewed loads; execution rejects if the
  // underlying records changed or the token expired (TOCTOU protection).
  previewToken: z.string().min(1),
});
const MAX_PERIOD_DAYS = 45;

const listQuerySchema = z.object({
  status: z.enum(["PENDING", "SCHEDULED", "PROCESSING", "TRANSFERRED", "PAID_OUT", "OFFSET", "FAILED", "HELD", "REVERSED"]).optional(),
  workerId: z.string().cuid().optional(),
});

/**
 * Lists existing settlements — the missing piece for the settlement
 * operations dashboard. Generation (POST, below) and the approve/pay
 * routes already existed and were correct; there was simply no way to
 * see what settlements exist, at what status, to actually approve or
 * pay them from — the same missing-lookup shape as every other admin
 * panel built this engagement (refund console, capture queue, payout
 * queue, partner invoicing).
 */
export async function GET(request: Request) {
  try {
    await requireRole(request, ["ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const { searchParams } = new URL(request.url);
  const parsed = listQuerySchema.safeParse({ status: searchParams.get("status") ?? undefined, workerId: searchParams.get("workerId") ?? undefined });
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const settlements = await prisma.settlement.findMany({
    where: { status: parsed.data.status, workerId: parsed.data.workerId },
    select: {
      id: true, periodStart: true, periodEnd: true, loadsSettled: true, grossCents: true,
      adjustmentsCents: true, netCents: true, status: true, approvedAt: true, paidAt: true,
      paidOutAt: true, failureReason: true, reversedAt: true, createdAt: true,
      worker: { select: { id: true, displayName: true, stripePayoutsEnabled: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return NextResponse.json({ settlements });
}

export async function POST(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const parsed = generateSchema.safeParse(await request.json());
  if (!parsed.success) {
    const needsConfirm = parsed.error.issues.some((i) => i.path.includes("confirm"));
    if (needsConfirm) {
      return NextResponse.json({ error: "Confirmation required. POST /api/settlements/preview first, review the eligible/skipped summary, then resubmit with confirm:true.", confirmationRequired: true }, { status: 428 });
    }
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const periodStart = new Date(parsed.data.periodStart);
  const periodEnd = new Date(parsed.data.periodEnd);
  if (periodEnd <= periodStart) return NextResponse.json({ error: "`periodEnd` must be after `periodStart`." }, { status: 400 });
  const spanDays = (periodEnd.getTime() - periodStart.getTime()) / 86_400_000;
  if (spanDays > MAX_PERIOD_DAYS) return NextResponse.json({ error: `Settlement period cannot exceed ${MAX_PERIOD_DAYS} days.` }, { status: 400 });

  const worker = await prisma.workerProfile.findUnique({ where: { id: parsed.data.workerId } });
  if (!worker) return NextResponse.json({ error: "Worker not found." }, { status: 404 });

  // Verify the preview token: valid signature, not expired, and bound to THIS
  // worker + period + admin. The content fingerprint is re-checked inside the
  // transaction below against current data.
  const verified = await verifyPreviewToken(parsed.data.previewToken);
  if (!verified.ok) {
    const msg = verified.reason === "expired"
      ? "Your settlement preview expired. Re-run the preview and confirm again."
      : "Invalid settlement preview token. Re-run the preview.";
    return NextResponse.json({ error: msg }, { status: 409 });
  }
  if (verified.claims.userId !== authed.userId || verified.claims.workerId !== parsed.data.workerId
      || verified.claims.periodStart !== periodStart.toISOString() || verified.claims.periodEnd !== periodEnd.toISOString()) {
    return NextResponse.json({ error: "Preview token does not match this settlement request." }, { status: 409 });
  }
  const expectedFingerprint = verified.claims.fingerprint;

  // Populated inside the tx by the partition step; surfaced in the response so
  // the admin sees exactly which markets were excluded and why.
  let skippedSummary: { marketLabel: string; count: number }[] = [];
  let skippedLoadIds: string[] = [];

  // Eligibility read, claim, and total computation all happen inside one
  // Serializable transaction — the exact concurrency-safety fix from the
  // V23 audit finding earlier in this engagement (a race here could
  // double-settle the same load). Re-derives eligibility inside the
  // transaction rather than trusting IDs collected beforehand.
  try {
    const settlement = await prisma.$transaction(async (tx) => {
      const capturedLoads = await tx.carrierRoute.findMany({
        where: {
          assignedWorkerId: worker.id,
          paymentStatus: "CAPTURED",
          settlementId: null,
          deliveredAt: { gte: periodStart, lt: periodEnd },
        },
        include: { originMarket: { select: { id: true, state: true, name: true } } },
      });
      // Pay before dispatch — VASRUE Digital Media, 29 Oct 2026: a prepaid load is
      // captured at posting, so it qualifies only once its POD has been accepted.
      const allEligibleLoads = await onlyPodAcceptedLoads(tx, capturedLoads);
      if (allEligibleLoads.length === 0) throw new Error("NO_ELIGIBLE_LOADS");

      // Option 1 partial settlement: include only loads whose origin market
      // this admin is authorized for; collect the rest as a skipped summary
      // (never silently omit). Fail closed — a load with no resolvable market
      // is settleable only by a platform-scope admin.
      const partition = await partitionByMarketAccess(
        authed.userId,
        allEligibleLoads.map((l) => ({
          record: l,
          marketId: l.originMarket?.id ?? null,
          marketState: l.originMarket?.state ?? null,
          marketLabel: l.originMarket?.name ?? null,
          territoryId: null,
        })),
        tx,
      );
      const eligibleLoads = partition.authorized;
      skippedSummary = partition.skipped;
      const authorizedIds = new Set(eligibleLoads.map((l) => l.id));
      skippedLoadIds = allEligibleLoads.filter((l) => !authorizedIds.has(l.id)).map((l) => l.id);
      if (eligibleLoads.length === 0) throw new Error("NO_AUTHORIZED_LOADS");

      // TOCTOU guard: recompute the batch fingerprint from CURRENT data and
      // reject if it differs from what the admin previewed. Catches loads that
      // were added, removed, re-priced, or settled elsewhere between preview
      // and confirmation.
      const currentFingerprint = computeBatchFingerprint({
        workerId: worker.id,
        periodStart: periodStart.toISOString(),
        periodEnd: periodEnd.toISOString(),
        eligible: eligibleLoads.map((l) => ({ id: l.id, grossCarrierCents: l.grossCarrierCents, paymentStatus: l.paymentStatus, settlementId: l.settlementId })),
        skippedLoadIds,
      });
      if (currentFingerprint !== expectedFingerprint) throw new Error("BATCH_CHANGED");

      const grossCents = eligibleLoads.reduce((sum, l) => sum + l.grossCarrierCents, 0);

      const eligibleDetention = await tx.detentionCharge.findMany({
        where: {
          loadId: { in: eligibleLoads.map((l) => l.id) },
          paymentStatus: "CAPTURED",
          settlementLine: null,
        },
      });
      const detentionCents = eligibleDetention.reduce((sum, d) => sum + d.amountCents, 0);

      // Step 6: provider also receives the provider-share of APPROVED
      // accessorials on these loads. Mirrors detention: summed into net and
      // the accessorials are flipped to SETTLED so they can't be paid twice.
      const eligibleLoadIds = eligibleLoads.map((l) => l.id);
      const accessorialRows = await tx.bookingAccessorial.findMany({
        where: { loadId: { in: eligibleLoadIds }, status: "APPROVED" },
        select: { id: true, providerShareCents: true },
      });
      const accessorialProviderCents = accessorialRows.reduce((s, a) => s + a.providerShareCents, 0);

      const netCents = grossCents + detentionCents + accessorialProviderCents;

      const created = await tx.settlement.create({
        data: {
          workerId: worker.id, periodStart, periodEnd,
          loadsSettled: eligibleLoads.length, grossCents, adjustmentsCents: detentionCents + accessorialProviderCents, netCents,
          status: "PENDING",
        },
      });

      const claim = await tx.carrierRoute.updateMany({
        where: {
          id: { in: eligibleLoads.map((l) => l.id) },
          assignedWorkerId: worker.id, paymentStatus: "CAPTURED", settlementId: null,
          deliveredAt: { gte: periodStart, lt: periodEnd },
        },
        data: { settlementId: created.id },
      });
      if (claim.count !== eligibleLoads.length) throw new Error("CONCURRENT_SETTLEMENT_CLAIM");

      if (eligibleDetention.length > 0) {
        await tx.settlementDetentionLine.createMany({
          data: eligibleDetention.map((d) => ({ settlementId: created.id, detentionChargeId: d.id, loadId: d.loadId, amountCents: d.amountCents })),
        });
      }

      // Flip the settled accessorials APPROVED -> SETTLED, guarded on the
      // prior status so a concurrent settlement can't double-pay them.
      if (accessorialRows.length > 0) {
        const settledAcc = await tx.bookingAccessorial.updateMany({
          where: { id: { in: accessorialRows.map((a) => a.id) }, status: "APPROVED" },
          data: { status: "SETTLED" },
        });
        if (settledAcc.count !== accessorialRows.length) throw new Error("CONCURRENT_SETTLEMENT_CLAIM");
      }

      await tx.auditLog.create({
        data: { actorId: authed.userId, action: "SETTLEMENT_CREATED", entityType: "Settlement", entityId: created.id, details: { workerId: worker.id, periodStart, periodEnd, loadsSettled: eligibleLoads.length, netCents, skippedMarkets: skippedSummary, skippedLoadIds } },
      });

      return created;
    }, { isolationLevel: "Serializable" });

    return NextResponse.json({ settlement, skippedMarkets: skippedSummary, skippedLoadIds }, { status: 201 });
  } catch (e) {
    if (e instanceof Error && e.message === "NO_ELIGIBLE_LOADS") {
      return NextResponse.json({ error: "No eligible loads found for this worker and period." }, { status: 409 });
    }
    if (e instanceof Error && e.message === "NO_AUTHORIZED_LOADS") {
      // Fail closed: eligible loads existed, but none in a market this admin
      // may settle. Report the skipped markets so it's not a silent denial.
      return NextResponse.json({ error: "No loads in a market you're authorized to settle.", skippedMarkets: skippedSummary }, { status: 403 });
    }
    if (e instanceof Error && e.message === "BATCH_CHANGED") {
      // The eligible records changed between preview and confirmation.
      return NextResponse.json({ error: "The settlement batch changed since your preview. Re-run the preview and confirm the updated batch.", batchChanged: true }, { status: 409 });
    }
    if (e instanceof Error && e.message === "CONCURRENT_SETTLEMENT_CLAIM") {
      return NextResponse.json({ error: "One or more loads were claimed by a concurrent settlement — please retry." }, { status: 409 });
    }
    throw e;
  }
}
