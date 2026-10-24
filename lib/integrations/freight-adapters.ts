/**
 * Freight provider adapters (extension points — NOT implemented).
 *
 * Plugin/adapter pattern: one adapter per external provider (load board, ELD,
 * telematics). Core dispatch logic depends ONLY on these interfaces, never on
 * a specific vendor — so adding DAT, Truckstop, Samsara, Motive, etc. later is
 * a NEW adapter file, not a change to dispatch/settlement/pricing.
 *
 * Nothing here is wired or called. Each capability is gated by a
 * FUTURE_FEATURE_KEY and stays dormant until (a) its flag is enabled AND (b) a
 * real adapter is registered. Live API automation (DAT/Truckstop sync, ELD
 * polling) is deliberately POST-Indianapolis-launch work; at launch, freight
 * runs on the internal load board + manual external-load import, which need
 * none of these.
 *
 * Types are intentionally minimal where the real contract isn't specified yet
 * — a signal that the shape is provisional, not a hidden commitment.
 */
import type { LoadBoardProvider } from "@prisma/client";

/** Common shape every adapter shares, so the registry can treat them uniformly. */
export interface ProviderAdapter {
  readonly providerKey: string; // stable id, e.g. "DAT", "SAMSARA"
  readonly featureKey: string;  // the FUTURE_FEATURE_KEY gating it
  readonly apiVersion?: string; // provider API version this adapter targets, if known
  /**
   * OPTIONAL local configuration metadata — NO network call. Reports what the
   * adapter can determine from its own config (credentials present? which
   * environment?). Safe to call regardless of the feature flag, so a DISABLED
   * provider can still show "Credentials configured · Sandbox" without probing
   * an external system.
   */
  configurationStatus?(): ProviderConfiguration;
  /** Cheap liveness/credential check; adapters implement, core calls before use. */
  healthCheck(): Promise<{ ok: boolean; detail?: string }>;
  /**
   * OPTIONAL richer status for the admin health dashboard. Adapters report only
   * what they actually track; anything they don't know stays undefined (the
   * dashboard shows "not tracked" rather than a fabricated value). Never throws
   * — errors surface as lastError.
   */
  status?(): Promise<ProviderStatus>;
}

/** Health/observability snapshot for one provider. undefined = not tracked. */
export type ProviderStatus = {
  connected?: boolean;         // credentials present + reachable
  environment?: "SANDBOX" | "PRODUCTION"; // which provider env the creds target
  credentialsConfigured?: boolean; // are the required creds present at all?
  lastSuccessfulSyncAt?: string | null;
  lastError?: string | null;
  lastErrorAt?: string | null;
  lastSuccessCode?: number | null; // last successful API HTTP status
  lastFailureCode?: number | null; // last failed API HTTP status
  consecutiveFailures?: number | null;
  credentialExpiresAt?: string | null;
};

/** Local, network-free configuration metadata for a provider. */
export type ProviderConfiguration = {
  credentialsConfigured: boolean;
  environment?: "SANDBOX" | "PRODUCTION";
  apiVersion?: string;
};

// ---- Load boards (DAT, Truckstop, 123Loadboard, ...) ----

export type ExternalLoad = {
  externalLoadId: string;
  provider: LoadBoardProvider;
  originCity: string; originState: string; originZip?: string;
  destinationCity: string; destinationState: string;
  equipment?: string;
  postedRateCents?: number;
  raw?: unknown; // provider payload, opaque to core
};

export interface LoadBoardAdapter extends ProviderAdapter {
  /** Search external loads. POST-launch automation replaces manual import. */
  searchLoads(query: { originZip?: string; destinationState?: string; equipment?: string }): Promise<ExternalLoad[]>;
  /** Fetch one external load by id (for import/verification). */
  getLoad(externalLoadId: string): Promise<ExternalLoad | null>;
}

// ---- ELD / Hours-of-Service (Samsara, Motive, Geotab, ...) ----

export type HosStatus = { driverId: string; dutyStatus: "off" | "sleeper" | "driving" | "on_duty"; drivingSecondsRemaining?: number; asOf: string };

export interface EldAdapter extends ProviderAdapter {
  getHosStatus(externalDriverId: string): Promise<HosStatus | null>;
}

// ---- Telematics / GPS (position, not HOS) ----

export type VehiclePosition = { vehicleId: string; lat: number; lng: number; speedMph?: number; asOf: string };

export interface TelematicsAdapter extends ProviderAdapter {
  getPosition(externalVehicleId: string): Promise<VehiclePosition | null>;
}

// ---- Verification adapters (FMCSA, identity, background, insurance) ----

export interface CarrierVerificationAdapter extends ProviderAdapter {
  /** FMCSA-style authority/safety lookup by DOT/MC number. */
  lookupAuthority(input: { dotNumber?: string; mcNumber?: string }): Promise<{ active: boolean; raw?: unknown } | null>;
}

/**
 * Registry contract. There is deliberately NO concrete instance — resolving an
 * adapter that isn't registered is a no-op (undefined), and callers must
 * fall back gracefully (e.g. manual import instead of API sync). Registration
 * happens later, per provider, behind its feature flag.
 */
export interface FreightAdapterRegistry {
  loadBoards: Partial<Record<string, LoadBoardAdapter>>;
  eld: Partial<Record<string, EldAdapter>>;
  telematics: Partial<Record<string, TelematicsAdapter>>;
  verification: Partial<Record<string, CarrierVerificationAdapter>>;
}
