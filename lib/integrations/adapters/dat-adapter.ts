/**
 * DAT load-board adapter — first production load-board integration.
 *
 * Implements LoadBoardAdapter against DAT's API. This is REAL adapter code:
 * request shaping, auth header, response→ExternalLoad mapping, error/timeout
 * handling. What it CANNOT do without you is authenticate: it requires DAT
 * commercial credentials (DAT_API_BASE_URL, DAT_API_KEY) that come from DAT's
 * commercial + developer-access process. Absent credentials, the adapter is
 * inert — health-check fails, and callers fall back to the internal board +
 * manual import.
 *
 * SAFETY / SEQUENCING:
 *  - Gated by the FREIGHT_BOARD_SYNC_DAT feature flag (OFF by default). Live
 *    sync only runs when the flag is enabled AND credentials are present.
 *  - The internal TempMovers load board and POST /api/loads/import remain the
 *    REQUIRED fallback paths — freight works at launch even if DAT is
 *    unavailable, un-credentialed, or uncertified.
 *  - This adapter READS external loads for import. It never moves money and is
 *    never on the settlement/payment path. An imported DAT load is created
 *    through the same createCarrierRouteLoad() money path as any other load.
 *
 * The exact DAT field names below are placeholders keyed to their developer
 * docs and MUST be reconciled against the live API contract during
 * certification — they are marked accordingly.
 */
import type { LoadBoardAdapter, ExternalLoad } from "@/lib/integrations/freight-adapters";

const DAT_TIMEOUT_MS = 8000;

function creds() {
  const baseUrl = process.env.DAT_API_BASE_URL;
  const apiKey = process.env.DAT_API_KEY;
  return baseUrl && apiKey ? { baseUrl, apiKey } : null;
}

async function datFetch(path: string, init?: RequestInit): Promise<Response> {
  const c = creds();
  if (!c) throw new Error("DAT credentials not configured");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DAT_TIMEOUT_MS);
  try {
    return await fetch(`${c.baseUrl}${path}`, {
      ...init,
      signal: controller.signal,
      headers: { "Authorization": `Bearer ${c.apiKey}`, "Accept": "application/json", ...(init?.headers ?? {}) },
    });
  } finally {
    clearTimeout(timer);
  }
}

// NOTE: field names below are provisional — reconcile with DAT's live schema
// during developer certification before enabling the flag in production.
type DatRawLoad = {
  id?: string;
  origin?: { city?: string; stateProv?: string; postalCode?: string };
  destination?: { city?: string; stateProv?: string };
  equipmentType?: string;
  rate?: { total?: number }; // dollars in DAT; converted to cents on mapping
};

function mapDatLoad(raw: DatRawLoad): ExternalLoad | null {
  if (!raw.id || !raw.origin?.city || !raw.origin?.stateProv || !raw.destination?.city || !raw.destination?.stateProv) {
    return null; // incomplete external record — skip rather than import garbage
  }
  return {
    externalLoadId: raw.id,
    provider: "DAT",
    originCity: raw.origin.city,
    originState: raw.origin.stateProv,
    originZip: raw.origin.postalCode,
    destinationCity: raw.destination.city,
    destinationState: raw.destination.stateProv,
    equipment: raw.equipmentType,
    postedRateCents: typeof raw.rate?.total === "number" ? Math.round(raw.rate.total * 100) : undefined,
    raw,
  };
}

export const datAdapter: LoadBoardAdapter = {
  providerKey: "DAT",
  featureKey: "FREIGHT_BOARD_SYNC_DAT",
  apiVersion: "v2", // provisional — confirm at certification

  configurationStatus() {
    const c = creds();
    // Purely local — no network. Environment inferred from the base URL.
    const environment: "SANDBOX" | "PRODUCTION" | undefined =
      c ? (/sandbox|staging|test/i.test(c.baseUrl) ? "SANDBOX" : "PRODUCTION") : undefined;
    return { credentialsConfigured: c != null, environment, apiVersion: "v2" };
  },

  async healthCheck() {
    if (!creds()) return { ok: false, detail: "DAT credentials not configured" };
    try {
      const res = await datFetch("/health");
      return res.ok ? { ok: true } : { ok: false, detail: `DAT health HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : "DAT health check failed" };
    }
  },

  async status() {
    // Report ONLY adapter-owned metadata — no network call. The dashboard/
    // endpoint already ran healthCheck() once and derives `connected` from it,
    // so calling healthCheck() again here would double the external traffic.
    // Per-call metrics (last sync, response codes, consecutive failures) need a
    // persistence layer the adapter doesn't have yet → stay undefined.
    const cfg = this.configurationStatus!();
    return {
      credentialsConfigured: cfg.credentialsConfigured,
      environment: cfg.environment,
    };
  },

  async searchLoads(query) {
    const params = new URLSearchParams();
    if (query.originZip) params.set("originPostalCode", query.originZip);
    if (query.destinationState) params.set("destinationStateProv", query.destinationState);
    if (query.equipment) params.set("equipmentType", query.equipment);
    const res = await datFetch(`/loads/search?${params.toString()}`);
    if (!res.ok) throw new Error(`DAT search HTTP ${res.status}`);
    const body = (await res.json()) as { results?: DatRawLoad[] };
    return (body.results ?? []).map(mapDatLoad).filter((l): l is ExternalLoad => l !== null);
  },

  async getLoad(externalLoadId) {
    const res = await datFetch(`/loads/${encodeURIComponent(externalLoadId)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`DAT getLoad HTTP ${res.status}`);
    return mapDatLoad((await res.json()) as DatRawLoad);
  },
};
