import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { SAFE_WORKER_SELECT } from "@/lib/access/sanitize-worker";
import { resolvePartnerReadAccess } from "@/lib/partner-permissions";
import { ruleById, RECOMMENDATION_MIN_RATING } from "@/lib/discovery/recommendations";

/**
 * Recommended workers (Phase 5) — RULE-BASED and TRANSPARENT. Every
 * returned worker carries a `reason` string (from the rule's describe())
 * that the UI shows. There is no opaque score. Two rules, applied in
 * order, deduplicated:
 *
 *   1. SAME_MARKET_HIGH_RATED — highly rated (>= RECOMMENDATION_MIN_RATING)
 *      workers in the partner's markets, not already in the network.
 *   2. SIMILAR_TO_RECENTLY_HIRED — workers sharing a skill and market
 *      with someone the customer recently hired, not already in network.
 *
 * Partner-scoped like the directory (needs partner read access) because
 * "not already in your network" is defined against the partner's
 * PreferredWorker roster.
 */
const LIMIT = 12;

export async function GET(request: Request, context: { params: Promise<{ partnerId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["CUSTOMER", "ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { partnerId } = await context.params;
  const access = await resolvePartnerReadAccess(prisma, partnerId, authed);
  if (!access.allowed) return NextResponse.json({ error: access.reason }, { status: access.reason === "Partner not found." ? 404 : 403 });

  // Workers already in this partner's preferred network — excluded from
  // every recommendation ("not already in your network").
  const preferred = await prisma.preferredWorker.findMany({ where: { partnerId }, select: { workerId: true } });
  const excludeIds = new Set(preferred.map(p => p.workerId));

  // The partner's own markets (direct PartnerMarket relation), for the
  // same-market rule. If the partner has no active markets, the
  // same-market rule simply yields nothing and we lean on rule 2.
  const partnerMarkets = await prisma.partnerMarket.findMany({
    where: { partnerId, active: true },
    select: { marketId: true },
  });
  const marketIds = Array.from(new Set(partnerMarkets.map(m => m.marketId)));

  const recommendations: { worker: unknown; rule: string; reason: string }[] = [];
  const chosen = new Set<string>();

  // Rule 1 — same market, highly rated.
  if (marketIds.length > 0) {
    const rule = ruleById("SAME_MARKET_HIGH_RATED");
    const candidates = await prisma.workerProfile.findMany({
      where: {
        operationalStatus: "ACTIVE",
        id: { notIn: Array.from(excludeIds) },
        ratingAverage: { gte: RECOMMENDATION_MIN_RATING },
        workerMarkets: { some: { marketId: { in: marketIds }, active: true } },
      },
      select: SAFE_WORKER_SELECT,
      orderBy: { ratingAverage: "desc" },
      take: LIMIT,
    });
    for (const w of candidates) {
      if (chosen.has(w.id)) continue;
      const marketName = w.workerMarkets[0]?.market?.name;
      recommendations.push({ worker: w, rule: rule.id, reason: rule.describe({ marketName }) });
      chosen.add(w.id);
    }
  }

  // Rule 2 — similar to a recently hired worker (shared skill + market).
  if (recommendations.length < LIMIT) {
    const customer = await prisma.customerProfile.findUnique({ where: { userId: authed.userId }, select: { id: true } });
    if (customer) {
      const lastHire = await prisma.assignment.findFirst({
        where: { status: { in: ["ACCEPTED", "CHECKED_IN", "CHECKED_OUT", "APPROVED"] }, job: { customerId: customer.id } },
        orderBy: { createdAt: "desc" },
        select: { worker: { select: { id: true, displayName: true, skills: { select: { skillId: true } }, workerMarkets: { select: { marketId: true } } } } },
      });
      if (lastHire) {
        const rule = ruleById("SIMILAR_TO_RECENTLY_HIRED");
        const skillIds = lastHire.worker.skills.map(s => s.skillId);
        const hireMarketIds = lastHire.worker.workerMarkets.map(m => m.marketId);
        if (skillIds.length > 0 && hireMarketIds.length > 0) {
          const similar = await prisma.workerProfile.findMany({
            where: {
              operationalStatus: "ACTIVE",
              id: { notIn: [...Array.from(excludeIds), ...Array.from(chosen), lastHire.worker.id] },
              skills: { some: { skillId: { in: skillIds } } },
              workerMarkets: { some: { marketId: { in: hireMarketIds }, active: true } },
            },
            select: SAFE_WORKER_SELECT,
            orderBy: { ratingAverage: "desc" },
            take: LIMIT - recommendations.length,
          });
          for (const w of similar) {
            if (chosen.has(w.id)) continue;
            recommendations.push({ worker: w, rule: rule.id, reason: rule.describe({ hiredWorkerName: lastHire.worker.displayName ?? undefined }) });
            chosen.add(w.id);
          }
        }
      }
    }
  }

  return NextResponse.json({ recommendations });
}
