/**
 * Google Maps Platform server-side geocoding client. Uses the standard
 * Geocoding API (https://maps.googleapis.com/maps/api/geocode/json), a
 * public documented contract — implemented for real, not stubbed. Untested
 * against the live endpoint in this environment (no network access here).
 *
 * Server-side key only (GOOGLE_MAPS_SERVER_KEY) — never the browser key
 * (NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY) here. Mixing them up would expose
 * a key with server-side quota/billing to the browser, or restrict a
 * server call with domain-restricted browser-key rules it can't satisfy.
 *
 * This handles address -> lat/lng only. Bridge height, weight, hazmat, and
 * truck-specific routing restrictions need a dedicated commercial truck
 * routing provider per the doc — not implemented here; do not use this
 * (or Google's consumer routing API) as a substitute for that.
 */

export class GeocodingNotConfiguredError extends Error {
  constructor() {
    super("GOOGLE_MAPS_SERVER_KEY is not configured.");
  }
}

export type GeocodeResult = {
  latitude: number;
  longitude: number;
  formattedAddress: string;
  placeId: string;
  locationType: string;
};

export async function geocodeAddress(address: string): Promise<GeocodeResult | null> {
  const key = process.env.GOOGLE_MAPS_SERVER_KEY;
  if (!key) throw new GeocodingNotConfiguredError();

  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${key}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Geocoding request failed with status ${res.status}.`);

  const data = await res.json();
  if (data.status !== "OK" || !data.results?.length) return null;

  const result = data.results[0];
  return {
    latitude: result.geometry.location.lat,
    longitude: result.geometry.location.lng,
    formattedAddress: result.formatted_address,
    placeId: result.place_id,
    locationType: result.geometry.location_type,
  };
}

export type DistanceResult = { distanceMiles: number; durationMinutes: number };

/** Straight-line-avoidant driving distance/duration between two coordinate pairs. */
export async function drivingDistance(
  origin: { latitude: number; longitude: number },
  destination: { latitude: number; longitude: number },
): Promise<DistanceResult | null> {
  const key = process.env.GOOGLE_MAPS_SERVER_KEY;
  if (!key) throw new GeocodingNotConfiguredError();

  const url =
    `https://maps.googleapis.com/maps/api/distancematrix/json` +
    `?origins=${origin.latitude},${origin.longitude}` +
    `&destinations=${destination.latitude},${destination.longitude}` +
    `&units=imperial&key=${key}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Distance Matrix request failed with status ${res.status}.`);

  const data = await res.json();
  const element = data.rows?.[0]?.elements?.[0];
  if (data.status !== "OK" || !element || element.status !== "OK") return null;

  return {
    distanceMiles: element.distance.value / 1609.344,
    durationMinutes: element.duration.value / 60,
  };
}
