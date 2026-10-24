/**
 * Integration health dashboard — PURE row assembler. Combines the inputs the
 * admin endpoint gathers (flag enabled?, health result, measured latency,
 * optional richer status, api version) into one dashboard row. No I/O here, so
 * the presentation logic is unit-testable. The endpoint does the actual flag
 * lookup + timed healthCheck + status() call and passes results in.
 *
 * Honesty rule baked in: a field the adapter does not report stays null and is
 * labeled "not tracked" by the UI — the dashboard never fabricates a
 * last-sync time or a healthy status. A provider that is enabled but
 * unreachable shows connected:false with the error, which is the whole point
 * of the dashboard.
 */
export type HealthInputs = {
  providerKey: string;
  featureKey: string;
  apiVersion?: string;
  enabled: boolean;                       // feature flag on?
  configuration?: {                       // LOCAL metadata, gathered regardless of flag
    credentialsConfigured?: boolean;
    environment?: "SANDBOX" | "PRODUCTION";
    apiVersion?: string;
  };
  health?: { ok: boolean; detail?: string }; // result of healthCheck (omitted if not run because disabled)
  latencyMs?: number | null;              // measured during healthCheck
  status?: {
    connected?: boolean;
    environment?: "SANDBOX" | "PRODUCTION";
    credentialsConfigured?: boolean;
    lastSuccessfulSyncAt?: string | null;
    lastError?: string | null;
    lastErrorAt?: string | null;
    lastSuccessCode?: number | null;
    lastFailureCode?: number | null;
    consecutiveFailures?: number | null;
    credentialExpiresAt?: string | null;
  };
};

export type HealthRow = {
  providerKey: string;
  featureKey: string;
  enabled: boolean;
  connected: boolean;
  state: "DISABLED" | "CONNECTED" | "DISCONNECTED" | "ERROR";
  environment: "SANDBOX" | "PRODUCTION" | null;
  configStatus: "CONFIGURED" | "MISSING_CREDENTIALS" | "UNKNOWN";
  lastSuccessfulSyncAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  lastSuccessCode: number | null;
  lastFailureCode: number | null;
  consecutiveFailures: number | null;
  latencyMs: number | null;
  apiVersion: string | null;
  credentialExpiresAt: string | null;
  credentialExpired: boolean | null; // null = unknown/not tracked
};

export function assembleHealthRow(input: HealthInputs, now: Date = new Date()): HealthRow {
  const s = input.status ?? {};
  const cfg = input.configuration ?? {};
  // connected: prefer the adapter's own signal, else derive from healthCheck.
  const connected = s.connected ?? (input.health ? input.health.ok : false);

  let state: HealthRow["state"];
  if (!input.enabled) state = "DISABLED";
  else if (connected) state = "CONNECTED";
  else if (input.health && !input.health.ok) state = "ERROR";
  else state = "DISCONNECTED";

  // credential expiry: only decide expired if we actually have a date.
  let credentialExpired: boolean | null = null;
  if (s.credentialExpiresAt) {
    const exp = new Date(s.credentialExpiresAt).getTime();
    credentialExpired = Number.isFinite(exp) ? exp <= now.getTime() : null;
  }

  const lastError = s.lastError ?? (input.health && !input.health.ok ? (input.health.detail ?? "unhealthy") : null);

  // Config status + environment come from LOCAL configuration first (available
  // even when disabled), then from live status, then UNKNOWN. This is what lets
  // a DISABLED provider still show "Credentials configured · Sandbox".
  const credsConfigured = cfg.credentialsConfigured ?? s.credentialsConfigured;
  const configStatus: HealthRow["configStatus"] =
    credsConfigured === true ? "CONFIGURED"
    : credsConfigured === false ? "MISSING_CREDENTIALS"
    : "UNKNOWN";
  const environment = cfg.environment ?? s.environment ?? null;
  const apiVersion = cfg.apiVersion ?? input.apiVersion ?? null;

  return {
    providerKey: input.providerKey,
    featureKey: input.featureKey,
    enabled: input.enabled,
    connected,
    state,
    environment,
    configStatus,
    lastSuccessfulSyncAt: s.lastSuccessfulSyncAt ?? null,
    lastError,
    lastErrorAt: s.lastErrorAt ?? null,
    lastSuccessCode: s.lastSuccessCode ?? null,
    lastFailureCode: s.lastFailureCode ?? null,
    consecutiveFailures: s.consecutiveFailures ?? null,
    latencyMs: input.latencyMs ?? null,
    apiVersion,
    credentialExpiresAt: s.credentialExpiresAt ?? null,
    credentialExpired,
  };
}
