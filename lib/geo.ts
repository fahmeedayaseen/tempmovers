/**
 * Geographic eligibility. This is the ONLY place this logic should live —
 * every feed, acceptance, and load-request route imports from here rather
 * than reimplementing the check, so a future rule change (e.g. adding a
 * grace radius) only has to happen once. The frontend may filter for
 * convenience, but it is never the authority; every route below re-checks
 * this server-side even if a client already filtered.
 */

export type GeoEligibilityInput = {
  workerMarketIds: string[];
  workerTerritoryIds: string[];
  homeLatitude?: number | null;
  homeLongitude?: number | null;
  serviceRadiusMiles?: number | null;
  jobMarketId: string | null;
  jobTerritoryId?: string | null;
  jobLatitude?: number | null;
  jobLongitude?: number | null;
};

export function haversineMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const earthRadiusMiles = 3958.8;
  const toRadians = (degrees: number) => degrees * (Math.PI / 180);

  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLon / 2) ** 2;

  return 2 * earthRadiusMiles * Math.asin(Math.sqrt(a));
}

/**
 * A worker can serve a location if:
 * 1. They're active in the job's market (hard requirement — no market
 *    membership means no eligibility, regardless of distance), AND either
 * 2. They're assigned to the job's specific territory, OR
 * 3. Their home location falls within their own service radius of the job.
 *
 * A job with no resolved market (marketId null, e.g. mid-migration/backfill)
 * is never eligible — fail closed, not open.
 *
 * 4. When rule 3 cannot be evaluated at all — either side has no coordinates
 *    or the worker has no radius — market membership (rule 1) decides on its
 *    own. See BLOCK-15 below.
 */
export function workerCanServeLocation(input: GeoEligibilityInput): boolean {
  if (!input.jobMarketId || !input.workerMarketIds.includes(input.jobMarketId)) {
    return false;
  }

  if (input.jobTerritoryId && input.workerTerritoryIds.includes(input.jobTerritoryId)) {
    return true;
  }

  // BLOCK-15 — VASRUE Digital Media, 27 October 2026.
  //
  // This returned false whenever the radius check lacked data, which made
  // rules 2 and 3 unsatisfiable for every real worker: nothing in the codebase
  // ever writes WorkerMarket.homeLatitude/homeLongitude (the territory
  // onboarding route stores only a radius), and nothing ever creates a
  // WorkerTerritory row. So no mover could accept any job or invitation, with
  // or without a geocoding provider configured. Found by driving a funded
  // booking end to end on staging: a fully onboarded mover in the job's own
  // market was refused as "outside your service area".
  //
  // POST /api/jobs already documents the intended degradation — without
  // coordinates, matching "falls back to market/territory membership alone"
  // and the job is flagged needsManualGeoReview for an admin. This makes the
  // check do what that route says. The radius rule still applies in full
  // whenever both locations and a radius exist, so it switches on by itself
  // once worker home locations are geocoded. Market membership stays a hard
  // requirement and a job with no market still fails closed.
  if (
    input.homeLatitude == null ||
    input.homeLongitude == null ||
    input.jobLatitude == null ||
    input.jobLongitude == null ||
    input.serviceRadiusMiles == null
  ) {
    return true;
  }

  const distance = haversineMiles(
    input.homeLatitude,
    input.homeLongitude,
    input.jobLatitude,
    input.jobLongitude,
  );

  return distance <= input.serviceRadiusMiles;
}
