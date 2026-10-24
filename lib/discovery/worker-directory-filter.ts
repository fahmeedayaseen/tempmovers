import { z } from "zod";

/**
 * THE canonical worker-directory filter/sort/paginate schema (Phase 5).
 * Deliberately in its own file, imported by BOTH the worker-directory
 * route and lib/discovery/saved-search.ts, so a saved search is
 * validated against the exact same contract the directory enforces —
 * a saved search can never smuggle in a field the directory doesn't
 * support, because there is only one schema. This is the anti-drift
 * guarantee the handoff calls for.
 *
 * Pure (schema only, no db) so saved-search validation is testable
 * without Prisma.
 */

// NOTE: "recentlyActive" was intentionally dropped — WorkerProfile has
// no last-activity/updatedAt timestamp, so there is no honest column to
// sort by. Rather than fake it with an unrelated date (approvedAt,
// firstCompletedJobAt), the option isn't offered. Add it back only if a
// real activity timestamp is introduced. "responseTime" is offered but
// falls back to rating in the route (it's a derived metric, not a
// sortable column) — see the route's orderBy comment.
export const SORT_FIELDS = ["rating", "completedJobs", "responseTime"] as const;
export type SortField = (typeof SORT_FIELDS)[number];

export const workerDirectoryFilterSchema = z.object({
  query: z.string().trim().max(200).optional(),
  workerType: z.enum(["MOVER", "BOX_TRUCK_DRIVER", "SEMI_DRIVER"]).optional(),
  marketId: z.string().cuid().optional(),
  skill: z.string().trim().max(80).optional(),
  languageCode: z.string().trim().length(2).optional(),
  minRating: z.number().min(0).max(5).optional(),
  verifiedOnly: z.boolean().optional(),
  acceptingJobsOnly: z.boolean().optional(),
  // Availability window filter — both required together or neither.
  availableFrom: z.string().datetime().optional(),
  availableTo: z.string().datetime().optional(),
  sort: z.enum(SORT_FIELDS).optional(),
  sortDir: z.enum(["asc", "desc"]).optional(),
  page: z.number().int().min(1).optional(),
  pageSize: z.number().int().min(1).max(50).optional(),
}).refine(
  d => (d.availableFrom == null) === (d.availableTo == null),
  { message: "availableFrom and availableTo must be provided together." }
).refine(
  d => !(d.availableFrom && d.availableTo) || new Date(d.availableFrom) < new Date(d.availableTo),
  { message: "availableFrom must be before availableTo." }
);

export type WorkerDirectoryFilter = z.infer<typeof workerDirectoryFilterSchema>;
