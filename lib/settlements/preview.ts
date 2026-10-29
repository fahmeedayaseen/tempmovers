/**
 * Settlement preview builder (handoff Option 3). Resolves the candidate loads
 * for a worker+period, partitions them by the admin's market authorization,
 * and returns the full summary the preview + confirmation flow needs:
 * eligible count/total, skipped count, skipped markets, skipped record IDs,
 * and the exclusion reason. One source of truth so preview and execution can
 * never disagree — execution calls this again to REVALIDATE before settling.
 *
 * Read-only: no claim, no status change. Uses the same partitionByMarketAccess
 * policy as everything else; no dedicated settlement permission.
 */
import { prisma } from "@/lib/db";
import { onlyPodAcceptedLoads } from "@/lib/payments/settlement";
import { partitionByMarketAccess } from "@/lib/market-access";
import type { Prisma } from "@prisma/client";

export type SettlementPreview = {
  eligibleCount: number;
  eligibleTotalCents: number;
  eligibleLoadIds: string[];
  skippedCount: number;
  skippedLoadIds: string[];
  skippedMarkets: { marketLabel: string; count: number }[];
  exclusionReason: string | null;
  // Minimal projection of eligible loads for the preview-token fingerprint.
  fingerprintLoads: { id: string; grossCarrierCents: number; paymentStatus: string; settlementId: string | null }[];
};

export async function buildSettlementPreview(
  params: { userId: string; workerId: string; periodStart: Date; periodEnd: Date },
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<SettlementPreview> {
  const allCandidates = await client.carrierRoute.findMany({
    where: {
      assignedWorkerId: params.workerId,
      paymentStatus: "CAPTURED",
      settlementId: null,
      deliveredAt: { gte: params.periodStart, lt: params.periodEnd },
    },
    include: { originMarket: { select: { id: true, state: true, name: true } } },
  });
  // Pay before dispatch (29 Oct 2026): prepaid loads wait for POD acceptance.
  const candidates = await onlyPodAcceptedLoads(client, allCandidates);

  const partition = await partitionByMarketAccess(
    params.userId,
    candidates.map((l) => ({
      record: l,
      marketId: l.originMarket?.id ?? null,
      marketState: l.originMarket?.state ?? null,
      marketLabel: l.originMarket?.name ?? null,
      territoryId: null,
    })),
    client,
  );

  const authorizedIds = new Set(partition.authorized.map((l) => l.id));
  const skippedLoadIds = candidates.filter((l) => !authorizedIds.has(l.id)).map((l) => l.id);
  const eligibleTotalCents = partition.authorized.reduce((s, l) => s + l.grossCarrierCents, 0);

  return {
    eligibleCount: partition.authorized.length,
    eligibleTotalCents,
    eligibleLoadIds: partition.authorized.map((l) => l.id),
    skippedCount: skippedLoadIds.length,
    skippedLoadIds,
    skippedMarkets: partition.skipped,
    exclusionReason: skippedLoadIds.length > 0 ? "Outside administrator authorization scope." : null,
    fingerprintLoads: partition.authorized.map((l) => ({ id: l.id, grossCarrierCents: l.grossCarrierCents, paymentStatus: l.paymentStatus, settlementId: l.settlementId })),
  };
}
