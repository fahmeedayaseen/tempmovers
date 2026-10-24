import { workerDirectoryFilterSchema, type WorkerDirectoryFilter } from "@/lib/discovery/worker-directory-filter";

/**
 * Validates the JSON params stored on / submitted for a SavedSearch
 * against the SAME schema the worker directory uses. Returns the parsed
 * filter or an error — the route uses this both when SAVING a search
 * (reject junk before it's persisted) and when REPLAYING one (a search
 * saved before a schema change can't replay with now-invalid params).
 *
 * Pure; no db. This is the guard that makes "saved searches store
 * criteria, never results" safe: the criteria are always re-validated
 * against the live directory contract.
 */
export function parseSavedSearchParams(raw: unknown):
  | { ok: true; filter: WorkerDirectoryFilter }
  | { ok: false; error: string } {
  const parsed = workerDirectoryFilterSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: "Saved search parameters are not valid for the current directory." };
  }
  return { ok: true, filter: parsed.data };
}
