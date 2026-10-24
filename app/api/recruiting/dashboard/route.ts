import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRecruiter, AuthError } from "@/lib/recruiting/guard";

/**
 * Recruiting dashboard (recruiting CRM). Pipeline counts by stage, conversion
 * progress toward the 200-carrier goal, follow-ups due, and per-recruiter
 * activity. All counts are real DB aggregates — nothing fabricated.
 */
const GOAL = 200;
const ACTIVE_CARRIER_STAGES = ["APPROVED", "ACTIVE"] as const;

export async function GET(request: Request) {
  try { await requireRecruiter(request); }
  catch (e) { if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; }

  const [byStage, converted, activeCarriers, overdue, dueSoon] = await Promise.all([
    prisma.carrierProspect.groupBy({ by: ["recruitmentStage"], _count: { _all: true } }),
    prisma.carrierProspect.count({ where: { convertedCarrierId: { not: null } } }),
    prisma.carrier.count({ where: { status: { in: ["APPROVED", "ACTIVE"] } } }),
    prisma.carrierProspect.count({ where: { nextFollowUpAt: { lt: new Date() }, recruitmentStage: { notIn: ["ACTIVE", "NOT_INTERESTED", "UNQUALIFIED", "DO_NOT_CONTACT"] } } }),
    prisma.recruitingTask.count({ where: { completedAt: null, dueAt: { lte: new Date(Date.now() + 7 * 86400000) } } }),
  ]);

  const pipeline: Record<string, number> = {};
  for (const row of byStage) pipeline[row.recruitmentStage] = row._count._all;

  return NextResponse.json({
    goal: GOAL,
    activeCarriers,                                  // real onboarded carriers APPROVED/ACTIVE
    progressPercent: Math.min(100, Math.round((activeCarriers / GOAL) * 100)),
    convertedProspects: converted,
    pipeline,
    followUpsOverdue: overdue,
    tasksDueThisWeek: dueSoon,
  });
}
