import { prisma } from "@/lib/db";
import type { LoadBoardProvider } from "@prisma/client";

/**
 * Every external load-board integration goes behind this interface — never
 * a generic "call whatever API" helper. Each provider gets its own adapter
 * with its own credential set (see .env.example), so an outage or contract
 * change in one provider can't reach into another, and TempMovers' own
 * marketplace (InternalMarketplaceAdapter) keeps working regardless of any
 * of them.
 */

export type NormalizedLoad = {
  externalLoadId: string;
  provider: LoadBoardProvider;
  title: string;
  equipmentType: string;
  originCity: string;
  originState: string;
  destinationCity: string;
  destinationState: string;
  rateCents: number | null;
  pickupDate: Date | null;
  raw: unknown;
};

export type LoadSearchInput = {
  equipmentType?: string;
  originState?: string;
  destinationState?: string;
  pickupDateFrom?: Date;
  pickupDateTo?: Date;
};

export type InternalLoad = {
  id: string;
  title: string;
  equipmentType: string;
  originCity: string;
  originState: string;
  destinationCity: string;
  destinationState: string;
  grossCarrierCents: number;
  pickupDate: Date;
};

export type ExternalPostResult = { externalLoadId: string; status: "POSTED" | "FAILED"; message?: string };
export type ExternalLoadStatus = { status: string; lastUpdatedAt: Date | null };

export interface ExternalLoadBoardAdapter {
  readonly provider: LoadBoardProvider;
  readonly configured: boolean;
  searchLoads(input: LoadSearchInput): Promise<NormalizedLoad[]>;
  postLoad(load: InternalLoad): Promise<ExternalPostResult>;
  updateLoad(load: InternalLoad): Promise<void>;
  removeLoad(loadId: string): Promise<void>;
  getLoadStatus(externalLoadId: string): Promise<ExternalLoadStatus>;
}

/** Thrown by any adapter method when its provider's credentials aren't set. */
export class AdapterNotConfiguredError extends Error {
  constructor(provider: string) {
    super(`${provider} credentials are not configured — this adapter is inactive.`);
  }
}

/**
 * TempMovers' own marketplace, wrapped in the same interface as external
 * providers. This is the real, always-available source — per the doc's own
 * "Final Recommendation," provider outages must never prevent use of the
 * internal load board, and this adapter is what guarantees that: it has no
 * external dependency at all.
 */
export const InternalMarketplaceAdapter: ExternalLoadBoardAdapter = {
  provider: "INTERNAL",
  configured: true,
  async searchLoads(input) {
    const rows = await prisma.carrierRoute.findMany({
      where: {
        sourceProvider: "INTERNAL",
        status: { in: ["OPEN", "OFFER_RECEIVED"] },
        ...(input.originState && { originState: input.originState }),
        ...(input.destinationState && { destinationState: input.destinationState }),
      },
      take: 100,
    });
    return rows.map((r) => ({
      externalLoadId: r.id,
      provider: "INTERNAL" as const,
      title: r.title,
      equipmentType: r.equipmentType,
      originCity: r.originCity,
      originState: r.originState,
      destinationCity: r.destinationCity,
      destinationState: r.destinationState,
      rateCents: r.grossCarrierCents,
      pickupDate: r.pickupDate,
      raw: r,
    }));
  },
  async postLoad(load) {
    // Internal loads are created directly via POST /api/loads, not through
    // this adapter — nothing to "post" externally for the internal source.
    return { externalLoadId: load.id, status: "POSTED" };
  },
  async updateLoad() {
    // Same reasoning as postLoad — internal updates go through the normal
    // load routes, not this adapter.
  },
  async removeLoad() {},
  async getLoadStatus(externalLoadId) {
    const row = await prisma.carrierRoute.findUnique({ where: { id: externalLoadId } });
    return { status: row?.status ?? "UNKNOWN", lastUpdatedAt: row?.lastSyncedAt ?? null };
  },
};

/**
 * Builds a stub adapter for a commercial provider whose API contract I have
 * no verified documentation for in this environment (Truckstop, DAT,
 * 123Loadboard, Uber Freight, Direct Freight all require partner/developer
 * agreements to even see their real request/response shapes). Every method
 * throws AdapterNotConfiguredError rather than fabricating a plausible-
 * looking integration that would silently do nothing or, worse, be wrong —
 * that would be more dangerous than an honest gap.
 *
 * Once real credentials and API docs exist for a provider, replace its stub
 * with a real implementation of ExternalLoadBoardAdapter — the call sites
 * (search, sync jobs, etc.) never need to change, only the registry below.
 */
function makeUnconfiguredStub(provider: LoadBoardProvider, envVarHint: string): ExternalLoadBoardAdapter {
  const fail = () => {
    throw new AdapterNotConfiguredError(`${provider} (set ${envVarHint} to enable)`);
  };
  return {
    provider,
    configured: false,
    searchLoads: async () => fail(),
    postLoad: async () => fail(),
    updateLoad: async () => fail(),
    removeLoad: async () => fail(),
    getLoadStatus: async () => fail(),
  };
}

export const TruckstopAdapter = makeUnconfiguredStub("TRUCKSTOP", "TRUCKSTOP_CLIENT_ID / TRUCKSTOP_CLIENT_SECRET");
export const DatAdapter = makeUnconfiguredStub("DAT", "DAT_CLIENT_ID / DAT_CLIENT_SECRET");
export const Loadboard123Adapter = makeUnconfiguredStub("LOADBOARD_123", "LOADBOARD_123_CLIENT_ID");
export const UberFreightAdapter = makeUnconfiguredStub("UBER_FREIGHT", "UBER_FREIGHT_CLIENT_ID");
export const DirectFreightAdapter = makeUnconfiguredStub("DIRECT_FREIGHT", "DIRECT_FREIGHT_API_TOKEN");

export const LOAD_BOARD_ADAPTERS: Record<LoadBoardProvider, ExternalLoadBoardAdapter> = {
  INTERNAL: InternalMarketplaceAdapter,
  TRUCKSTOP: TruckstopAdapter,
  DAT: DatAdapter,
  LOADBOARD_123: Loadboard123Adapter,
  UBER_FREIGHT: UberFreightAdapter,
  DIRECT_FREIGHT: DirectFreightAdapter,
};

/**
 * Normalizes and dedups an externally-sourced load before it can ever touch
 * the core CarrierRoute table — the schema's
 * @@unique([sourceProvider, externalLoadId]) constraint is the actual
 * enforcement (a duplicate sync is a no-op upsert, not a new row), this is
 * just the validated entry point that produces well-formed data for it.
 */
export async function upsertExternalLoad(load: NormalizedLoad) {
  if (load.provider === "INTERNAL") {
    throw new Error("upsertExternalLoad is only for externally-sourced loads.");
  }
  return prisma.carrierRoute.upsert({
    where: { sourceProvider_externalLoadId: { sourceProvider: load.provider, externalLoadId: load.externalLoadId } },
    update: {
      title: load.title,
      originCity: load.originCity,
      originState: load.originState,
      destinationCity: load.destinationCity,
      destinationState: load.destinationState,
      grossCarrierCents: load.rateCents ?? 0,
      pickupDate: load.pickupDate ?? new Date(),
      externalSyncStatus: "SYNCED",
      lastSyncedAt: new Date(),
    },
    create: {
      title: load.title,
      sourceProvider: load.provider,
      externalLoadId: load.externalLoadId,
      equipmentType: "OTHER",
      originCity: load.originCity,
      originState: load.originState,
      destinationCity: load.destinationCity,
      destinationState: load.destinationState,
      grossCarrierCents: load.rateCents ?? 0,
      platformFeeCents: 0,
      pickupDate: load.pickupDate ?? new Date(),
      estimatedHoursOrMiles: "Unknown — pending sync detail",
      externalSyncStatus: "SYNCED",
      lastSyncedAt: new Date(),
      status: "OPEN",
      visibility: "PUBLIC_PREVIEW",
    },
  });
}
