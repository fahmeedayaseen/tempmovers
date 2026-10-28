// VASRUE Digital Media — 27 October 2026.
// workerCanServeLocation decides whether a mover may accept a job or an invitation.
// It had no tests, which is how BLOCK-15 (no worker could ever pass it) went unseen.
import { describe, it, expect } from "vitest";
import { workerCanServeLocation, haversineMiles } from "@/lib/geo";

const INDY = "market-indy";
const CHI = "market-chicago";
// Downtown Indianapolis and Carmel, IN — about 15 miles apart.
const DOWNTOWN = { lat: 39.7684, lon: -86.1581 };
const CARMEL = { lat: 39.9784, lon: -86.118 };

const base = {
  workerMarketIds: [INDY],
  workerTerritoryIds: [] as string[],
  jobMarketId: INDY as string | null,
};

describe("workerCanServeLocation", () => {
  it("fails closed when the job has no market", () => {
    expect(workerCanServeLocation({ ...base, jobMarketId: null })).toBe(false);
  });

  it("refuses a worker who is not in the job's market, whatever the distance", () => {
    expect(workerCanServeLocation({
      ...base, workerMarketIds: [CHI],
      homeLatitude: DOWNTOWN.lat, homeLongitude: DOWNTOWN.lon, serviceRadiusMiles: 50,
      jobLatitude: DOWNTOWN.lat, jobLongitude: DOWNTOWN.lon,
    })).toBe(false);
  });

  it("allows a worker assigned to the job's territory", () => {
    expect(workerCanServeLocation({ ...base, workerTerritoryIds: ["t-north"], jobTerritoryId: "t-north" })).toBe(true);
  });

  it("allows a worker whose radius covers the job", () => {
    expect(workerCanServeLocation({
      ...base, homeLatitude: DOWNTOWN.lat, homeLongitude: DOWNTOWN.lon, serviceRadiusMiles: 20,
      jobLatitude: CARMEL.lat, jobLongitude: CARMEL.lon,
    })).toBe(true);
  });

  it("refuses a worker whose radius does not reach the job, when both locations are known", () => {
    expect(workerCanServeLocation({
      ...base, homeLatitude: DOWNTOWN.lat, homeLongitude: DOWNTOWN.lon, serviceRadiusMiles: 5,
      jobLatitude: CARMEL.lat, jobLongitude: CARMEL.lon,
    })).toBe(false);
  });

  // BLOCK-15: no code path writes a worker's home coordinates, and jobs have none
  // until a geocoding key is configured. Market membership decides in that case.
  it("falls back to market membership when the job has no coordinates", () => {
    expect(workerCanServeLocation({ ...base, homeLatitude: DOWNTOWN.lat, homeLongitude: DOWNTOWN.lon, serviceRadiusMiles: 5 })).toBe(true);
  });

  it("falls back to market membership when the worker has no home location", () => {
    expect(workerCanServeLocation({ ...base, serviceRadiusMiles: 30, jobLatitude: CARMEL.lat, jobLongitude: CARMEL.lon })).toBe(true);
  });

  it("falls back to market membership when the worker has no radius", () => {
    expect(workerCanServeLocation({
      ...base, homeLatitude: DOWNTOWN.lat, homeLongitude: DOWNTOWN.lon,
      jobLatitude: CARMEL.lat, jobLongitude: CARMEL.lon,
    })).toBe(true);
  });
});

describe("haversineMiles", () => {
  it("measures downtown Indianapolis to Carmel at about 15 miles", () => {
    const miles = haversineMiles(DOWNTOWN.lat, DOWNTOWN.lon, CARMEL.lat, CARMEL.lon);
    expect(miles).toBeGreaterThan(14);
    expect(miles).toBeLessThan(16);
  });
});
