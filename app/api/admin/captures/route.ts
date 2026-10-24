import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { calculateJobFinalCaptureAmount } from "@/lib/capture-preview";

/**
 * Lists jobs and freight loads that are actually ready for admin capture
 * — completed/delivered and AUTHORIZED, not yet CAPTURED — so the admin
 * capture buttons have something real to search and act on, the same
 * gap the refund console had (a working action route with nowhere to
 * find what to act on).
 *
 * Fixed after a review found the job side of this queue was displaying
 * job.estimatedTotalCents while the actual capture route charges a
 * different, hours-derived finalTotalCents — an admin could see one
 * number here and capture a different one. Now uses the exact same
 * calculateJobFinalCaptureAmount() helper the capture route itself
 * calls, so the two can never drift again — this is a shared
 * calculation, not two copies that happen to agree today. A job whose
 * hours aren't yet customer-approved shows that honestly (ready: false,
 * with the reason) instead of a number that would fail if clicked.
 */
export async function GET(request: Request) {
  try {
    await requireRole(request, ["ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const [jobs, loads] = await Promise.all([
    prisma.job.findMany({
      where: { status: "COMPLETED", paymentStatus: "AUTHORIZED" },
      select: {
        id: true, title: true, estimatedTotalCents: true, platformFeePerHourCents: true, urgentPremiumCents: true, bookingProtectionFeeCents: true,
        customer: { select: { user: { select: { firstName: true, lastName: true } } } },
      },
      orderBy: { updatedAt: "asc" },
      take: 50,
    }),
    prisma.carrierRoute.findMany({
      where: { status: "POD_UPLOADED", paymentStatus: "AUTHORIZED" },
      select: { id: true, title: true, grossCarrierCents: true, platformFeeCents: true, accessorialsCents: true },
      orderBy: { updatedAt: "asc" },
      take: 50,
    }),
  ]);

  const jobResults = await Promise.all(jobs.map(async (j) => {
    const preview = await calculateJobFinalCaptureAmount(prisma, j);
    const customerName = `${j.customer.user.firstName} ${j.customer.user.lastName}`;
    if (!preview.ok) {
      return { id: j.id, title: j.title, customerName, type: "job" as const, ready: false as const, reason: preview.reason, estimatedTotalCents: j.estimatedTotalCents };
    }
    return { id: j.id, title: j.title, customerName, type: "job" as const, ready: true as const, amountCents: preview.finalTotalCents, estimatedTotalCents: j.estimatedTotalCents };
  }));

  return NextResponse.json({
    jobs: jobResults,
    loads: loads.map((l) => ({ id: l.id, title: l.title, customerName: null, type: "load" as const, ready: true as const, amountCents: l.grossCarrierCents + l.platformFeeCents + (l.accessorialsCents || 0) })),
  });
}
