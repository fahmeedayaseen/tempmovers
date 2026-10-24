import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";

// Fallback list prices in cents, used only for the on-screen MRR estimate.
// The authoritative amount always lives in Stripe (the Price object), not
// here — this exists so the admin dashboard can show a number without an
// extra Stripe API round-trip per request. If these drift from the real
// Stripe Prices, the checkout session itself is still correct; only this
// estimate would be stale.
const PLAN_LIST_PRICE_CENTS: Record<string, number> = {
  MOVER: 1995,
  DRIVER_BASIC: 2995,
  OWNER_OPERATOR_PRO: 5995,
  FLEET: 14900,
};

export async function GET(request: Request) {
  try {
    await requireRole(request, ["ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const workers = await prisma.workerProfile.findMany({
    select: {
      id: true, subscriptionStatus: true, subscriptionPlan: true, subscriptionCurrentEnd: true,
      subscriptionWaivedUntilFirstJob: true, firstCompletedJobAt: true, completedJobs: true,
      user: { select: { firstName: true, lastName: true, role: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  const active = workers.filter((w) => w.subscriptionStatus === "ACTIVE");
  const waived = workers.filter(
    (w) => w.subscriptionWaivedUntilFirstJob && !w.firstCompletedJobAt && w.subscriptionStatus !== "ACTIVE",
  );
  const pastDue = workers.filter((w) => w.subscriptionStatus === "PAST_DUE");

  const byPlan: Record<string, number> = {};
  let estimatedMonthlyRevenueCents = 0;
  for (const w of active) {
    const plan = w.subscriptionPlan ?? "UNKNOWN";
    byPlan[plan] = (byPlan[plan] ?? 0) + 1;
    estimatedMonthlyRevenueCents += PLAN_LIST_PRICE_CENTS[plan] ?? 0;
  }

  return NextResponse.json({
    totals: {
      active: active.length,
      waived: waived.length,
      pastDue: pastDue.length,
      total: workers.length,
      estimatedMonthlyRevenueCents,
    },
    byPlan,
    workers: workers.map((w) => ({
      id: w.id,
      name: `${w.user.firstName} ${w.user.lastName}`,
      role: w.user.role,
      status: w.subscriptionStatus,
      plan: w.subscriptionPlan,
      renewsAt: w.subscriptionCurrentEnd,
      waived: w.subscriptionWaivedUntilFirstJob && !w.firstCompletedJobAt,
      completedJobs: w.completedJobs,
    })),
  });
}
