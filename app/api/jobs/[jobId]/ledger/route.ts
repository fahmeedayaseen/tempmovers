import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { evaluateFunding } from "@/lib/payments/funding";
import { JUNK_ALLOCATION_MODEL, type JunkQuotePlan } from "@/lib/junk/full-quote";
import { PAY_STATUS_LABELS, payStatus } from "@/lib/payments/pay-status";

/**
 * A job's payment picture, by role — VASRUE Digital Media, 29 October 2026.
 *
 * GET /api/jobs/[jobId]/ledger (payment spec §8, portals and controls).
 *   Customer: what was collected and when, the scope, change orders,
 *             receipts and refunds, and the disposal set-aside on junk.
 *   Worker:   their own pay basis, hours, reimbursement rule and payment
 *             status only. Never another worker's pay or private data.
 *   Admin:    use /api/admin/funding for the full ledger.
 * No card details or storage keys are ever returned.
 */
export async function GET(request: Request, context: { params: Promise<{ jobId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["CUSTOMER", "MOVER", "DRIVER", "ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { jobId } = await context.params;
  const job = await prisma.job.findUnique({ where: { id: jobId }, include: { customer: true } });
  if (!job) return NextResponse.json({ error: "Job not found." }, { status: 404 });

  const quote = await prisma.quoteVersion.findFirst({ where: { entityType: "JOB", entityId: jobId }, orderBy: { version: "desc" } });
  const plan = (quote?.plan ?? null) as unknown as JunkQuotePlan | null;
  const isJunkPlan = plan?.model === JUNK_ALLOCATION_MODEL;

  if (authed.role === "CUSTOMER" || authed.role === "ADMIN") {
    if (authed.role === "CUSTOMER" && job.customer.userId !== authed.userId) return NextResponse.json({ error: "Not your job." }, { status: 403 });
    const [funding, changeOrders, transactions, disposal] = await Promise.all([
      evaluateFunding({ type: "JOB", id: jobId }),
      prisma.changeOrder.findMany({ where: { entityType: "JOB", entityId: jobId }, orderBy: { version: "asc" } }),
      prisma.paymentTransaction.findMany({ where: { jobId }, include: { refunds: true }, orderBy: { createdAt: "asc" } }),
      prisma.disposalExpense.findUnique({ where: { jobId } }),
    ]);
    return NextResponse.json({
      payment: {
        status: funding.label, policy: funding.policyVersion, scopeCents: funding.requiredCents, collectedCents: funding.collectedCents, refundedCents: funding.refundedCents,
        collectedWhen: funding.attempts.length ? "In full when you booked, before any crew was dispatched" : "Under the earlier authorise-then-capture terms",
      },
      quote: quote ? { version: quote.version, totalCents: quote.totalCents, lines: quote.lines } : null,
      changeOrders: changeOrders.map((c) => ({ id: c.id, version: c.version, kind: c.kind, status: c.status, deltaCents: c.deltaCents, lines: c.lines, reason: c.reason, paidAt: c.paidAt })),
      receipts: transactions.map((t) => ({ amountCents: t.amountReceivedCents, brand: t.paymentMethodBrand, last4: t.paymentMethodLast4, receiptUrl: t.receiptUrl, at: t.createdAt })),
      refunds: transactions.flatMap((t) => t.refunds.map((r) => ({ amountCents: r.amountCents, status: r.status, reason: r.reason, at: r.createdAt }))),
      disposal: disposal ? { estimatedCents: disposal.estimatedCents, actualCents: disposal.state === "APPROVED" ? disposal.actualCents : null, status: disposal.state, rule: "Set aside from your total for the dump. If it costs less, the difference is refunded to you in full; if it will cost more, you're asked to approve and pay it first." } : null,
    });
  }

  // Workers: their own seat only.
  const worker = await prisma.workerProfile.findUnique({ where: { userId: authed.userId }, select: { id: true } });
  const seat = worker ? await prisma.assignment.findFirst({ where: { jobId, workerId: worker.id }, include: { payout: true } }) : null;
  if (!seat) return NextResponse.json({ error: "You aren't on this job." }, { status: 403 });

  const status = payStatus(seat.payout);
  const allocation = await prisma.paymentAllocation.findFirst({ where: { assignmentId: seat.id } });
  let basis: Record<string, unknown>;
  if (isJunkPlan && seat.junkCrewRole === "HELPER") {
    basis = { rule: "Paid hourly for your time on the job, from check-in to release", hourlyCents: plan.helperHourlyCents, minimumHours: plan.helperMinimumMinutes / 60, incrementMinutes: plan.helperIncrementMinutes, plannedHours: (plan.helperMinutes[0] ?? 0) / 60, estimatedCents: plan.helperCompCents[0] ?? 0 };
  } else if (isJunkPlan && seat.junkCrewRole === "HAULER") {
    const disposal = await prisma.disposalExpense.findUnique({ where: { jobId } });
    const reimbursement = await prisma.paymentAllocation.findFirst({ where: { entityType: "JOB", entityId: jobId, recipient: "DISPOSAL" } });
    basis = {
      rule: "Service earnings: the job's service price after disposal, less the 30% platform fee and the helpers' hourly pay. Fuel, insurance and the truck come out of this.",
      estimatedServiceCents: plan.haulerServiceCents,
      disposal: { allowanceCents: disposal?.estimatedCents ?? plan.disposalCents, submittedCents: disposal?.actualCents ?? null, status: disposal?.state ?? "ESTIMATED", reimbursementStatus: reimbursement?.state ?? "ESTIMATED", rule: "Reimbursed separately against the dump receipt, up to the funded allowance." },
    };
  } else {
    basis = { rule: "Paid per approved hour", rateCents: seat.agreedEarningsCents, minimumHours: job.minimumHours };
  }

  return NextResponse.json({
    seat: { role: seat.junkCrewRole ?? "WORKER", status: seat.status, scheduledHours: Number(seat.scheduledHours), actualHours: seat.actualHours == null ? null : Number(seat.actualHours) },
    pay: { basis, amountCents: allocation?.amountCents ?? seat.payout?.grossEarningsCents ?? null, status, statusLabel: PAY_STATUS_LABELS[status] },
  });
}
