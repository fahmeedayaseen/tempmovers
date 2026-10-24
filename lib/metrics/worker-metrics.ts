import type { AssignmentStatus } from "@prisma/client";

/**
 * Phase 5 worker metrics. Split into a PURE calculation layer (this
 * file's compute* functions, which take plain rows and are unit-tested
 * without a database) and a thin DB-fetch wrapper (lib/metrics/
 * worker-metrics-db.ts). Same separation used for invitation templates
 * in Phase 4, and for the same reason: the sandbox can't run Prisma, so
 * the logic that actually needs testing must be importable without it.
 *
 * ONLY the metrics whose source data the Phase 5 audit confirmed are
 * implemented here: completion rate and response time. On-time rate is
 * deliberately absent — there is no explicit expected-arrival field, so
 * per the handoff it is deferred rather than shipped as a misleading
 * proxy. Do not add an on-time function here until such a field exists.
 */

export type AssignmentMetricRow = {
  status: AssignmentStatus;
  createdAt: Date;
  respondedAt: Date | null;
};

/**
 * Completion rate, with the definition written down and applied
 * consistently (the handoff's explicit requirement).
 *
 * Numerator: assignments the worker actually completed —
 *   APPROVED or CHECKED_OUT.
 * Denominator: completed + genuine failures to complete —
 *   NO_SHOW and CANCELED.
 *
 * Deliberately EXCLUDED from the denominator:
 *   - DECLINED / INVITED / APPLIED: declining or not-yet-responding is
 *     not a failure to complete a job the worker took on. Counting them
 *     would punish a worker for being selective, which is not what a
 *     "completion rate" means.
 *   - ACCEPTED / CHECKED_IN: in-flight, outcome not yet known.
 *
 * Returns null (not 0) when the denominator is empty — "no completed or
 * failed jobs yet" is "no data," and showing 0% would libel a brand-new
 * worker. Callers render null as "Not enough data," never as a number.
 */
export function computeCompletionRate(rows: AssignmentMetricRow[]): number | null {
  let completed = 0;
  let failed = 0;
  for (const r of rows) {
    if (r.status === "APPROVED" || r.status === "CHECKED_OUT") completed++;
    else if (r.status === "NO_SHOW" || r.status === "CANCELED") failed++;
  }
  const denom = completed + failed;
  if (denom === 0) return null;
  return completed / denom;
}

/**
 * Median response time in milliseconds — invited (createdAt) to first
 * response (respondedAt). Median, not mean, because a single stale
 * invitation a worker ignored for days would wreck a mean and
 * misrepresent their typical responsiveness (the handoff mandates
 * median).
 *
 * Only assignments that actually have a respondedAt count — an
 * unanswered invitation has no response time yet, so it's excluded
 * rather than treated as infinite. Returns null when no assignment has
 * been responded to (rendered as "No data," never 0).
 */
export function computeMedianResponseMs(rows: AssignmentMetricRow[]): number | null {
  const deltas: number[] = [];
  for (const r of rows) {
    if (r.respondedAt) {
      const d = r.respondedAt.getTime() - r.createdAt.getTime();
      // Guard against clock-skew / bad data producing negatives.
      if (d >= 0) deltas.push(d);
    }
  }
  if (deltas.length === 0) return null;
  deltas.sort((a, b) => a - b);
  const mid = Math.floor(deltas.length / 2);
  return deltas.length % 2 === 0 ? (deltas[mid - 1] + deltas[mid]) / 2 : deltas[mid];
}

export type WorkerMetrics = {
  completionRate: number | null;
  medianResponseMs: number | null;
};

export function computeWorkerMetrics(rows: AssignmentMetricRow[]): WorkerMetrics {
  return {
    completionRate: computeCompletionRate(rows),
    medianResponseMs: computeMedianResponseMs(rows),
  };
}
