/**
 * Phase 5 availability badge. Turns a worker's raw Availability rows
 * into a single coarse, safe signal — the handoff is explicit that the
 * raw calendar (exact windows) must NOT be exposed to businesses, only
 * a derived badge. This file returns a badge string and nothing that
 * could reconstruct the underlying schedule.
 *
 * Pure and db-free (takes rows) so it's unit-testable without Prisma.
 * acceptingJobs (the worker-controlled boolean already in
 * SAFE_WORKER_SELECT) remains the PRIMARY availability signal; this
 * badge is a secondary, calendar-derived hint layered on top.
 */

export type AvailabilityWindow = { startsAt: Date; endsAt: Date; isAvailable: boolean };

export type AvailabilityBadge = "AVAILABLE_NOW" | "AVAILABLE_THIS_WEEK" | "AVAILABLE_LATER" | "NO_UPCOMING";

/**
 * Coarsens upcoming availability into one badge. Deliberately lossy —
 * the exact windows never leave this function. "This week" means within
 * 7 days of `now`. A window counts only if isAvailable is true and it
 * hasn't already ended.
 */
export function deriveAvailabilityBadge(windows: AvailabilityWindow[], now: Date = new Date()): AvailabilityBadge {
  const weekOut = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  let availableThisWeek = false;
  let availableLater = false;

  for (const w of windows) {
    if (!w.isAvailable) continue;
    if (w.endsAt <= now) continue; // already over
    if (w.startsAt <= now && w.endsAt > now) return "AVAILABLE_NOW"; // currently inside a window
    if (w.startsAt <= weekOut) availableThisWeek = true;
    else availableLater = true;
  }

  if (availableThisWeek) return "AVAILABLE_THIS_WEEK";
  if (availableLater) return "AVAILABLE_LATER";
  return "NO_UPCOMING";
}

/**
 * Does this worker have ANY available window overlapping [from, to]?
 * Used by the discovery "available in window" FILTER — the caller
 * supplies a window and gets a yes/no, so the filter can run without
 * ever returning the calendar itself. Pure; the route does the actual
 * DB filtering, this documents/tests the overlap rule.
 */
export function hasAvailabilityInWindow(windows: AvailabilityWindow[], from: Date, to: Date): boolean {
  return windows.some(w => w.isAvailable && w.startsAt < to && w.endsAt > from);
}
