/**
 * Load-board adapter resolver. Returns a live adapter ONLY when its feature
 * flag is enabled AND it reports healthy (credentials present + reachable).
 * Otherwise returns null so callers fall back to the internal board + manual
 * import — the required fallback path. This is the seam that keeps launch from
 * depending on any single external provider.
 *
 * Registration is explicit and additive: adding Truckstop later is one entry
 * here + one adapter file, no change to callers.
 */
import { datAdapter } from "@/lib/integrations/adapters/dat-adapter";
import type { LoadBoardAdapter } from "@/lib/integrations/freight-adapters";
import { isFeatureEnabled } from "@/lib/feature-flags/gate";

const REGISTERED: LoadBoardAdapter[] = [
  datAdapter,
  // truckstopAdapter,  // added as second integration once certified
];

/**
 * Resolve a healthy, flag-enabled load-board adapter by provider key, or null.
 * Never throws — a provider being down must degrade to fallback, not error.
 */
export async function resolveLoadBoardAdapter(providerKey: string): Promise<LoadBoardAdapter | null> {
  const adapter = REGISTERED.find((a) => a.providerKey === providerKey);
  if (!adapter) return null;
  try {
    const enabled = await isFeatureEnabled(adapter.featureKey);
    if (!enabled) return null; // flag off → fallback
    const health = await adapter.healthCheck();
    return health.ok ? adapter : null; // unhealthy → fallback
  } catch {
    return null; // any error → fallback
  }
}

/** All registered load-board adapters (for the admin health dashboard). */
export function registeredLoadBoardAdapters(): LoadBoardAdapter[] {
  return [...REGISTERED];
}

/** List provider keys that are currently live (flag on + healthy). */
export async function liveLoadBoardProviders(): Promise<string[]> {
  const live: string[] = [];
  for (const a of REGISTERED) {
    try {
      if ((await isFeatureEnabled(a.featureKey)) && (await a.healthCheck()).ok) live.push(a.providerKey);
    } catch { /* skip */ }
  }
  return live;
}
