import { prisma } from "@/lib/db";
import { computeWorkerMetrics, type WorkerMetrics } from "@/lib/metrics/worker-metrics";

/**
 * Fetches the assignment rows a worker's metrics are computed from and
 * runs the pure calculators. Kept out of worker-metrics.ts so that file
 * stays db-free and unit-testable. Selects only the three fields the
 * calculators need — not whole Assignment rows.
 */
export async function getWorkerMetrics(workerId: string): Promise<WorkerMetrics> {
  const rows = await prisma.assignment.findMany({
    where: { workerId },
    select: { status: true, createdAt: true, respondedAt: true },
  });
  return computeWorkerMetrics(rows);
}

/**
 * Batch variant for discovery lists — one query for many workers, then
 * group and compute per worker, so a directory page of 50 workers
 * doesn't fire 50 metric queries. Returns a Map keyed by workerId;
 * workers with no assignments simply get null metrics from the pure
 * layer.
 */
export async function getWorkerMetricsBatch(workerIds: string[]): Promise<Map<string, WorkerMetrics>> {
  const result = new Map<string, WorkerMetrics>();
  if (workerIds.length === 0) return result;
  const rows = await prisma.assignment.findMany({
    where: { workerId: { in: workerIds } },
    select: { workerId: true, status: true, createdAt: true, respondedAt: true },
  });
  const byWorker = new Map<string, { status: typeof rows[number]["status"]; createdAt: Date; respondedAt: Date | null }[]>();
  for (const r of rows) {
    const list = byWorker.get(r.workerId) ?? [];
    list.push({ status: r.status, createdAt: r.createdAt, respondedAt: r.respondedAt });
    byWorker.set(r.workerId, list);
  }
  for (const id of workerIds) {
    result.set(id, computeWorkerMetrics(byWorker.get(id) ?? []));
  }
  return result;
}
