import { NextResponse } from "next/server";
import { requireRole, AuthError } from "@/lib/auth";
import { registeredLoadBoardAdapters } from "@/lib/integrations/adapters/registry";
import { isFeatureEnabled } from "@/lib/feature-flags/gate";
import { assembleHealthRow, type HealthInputs } from "@/lib/integrations/health";

/**
 * Admin Integration Health Dashboard (read-only observability).
 *
 * For each registered provider adapter, reports: enabled/disabled, connected/
 * disconnected, last successful sync, last error, API latency, API version,
 * and credential expiration — as far as each adapter actually tracks them.
 * Fields an adapter doesn't report are returned null and shown as "not
 * tracked"; the dashboard never fabricates a healthy status.
 *
 * Admin-only. Runs each adapter's healthCheck (timed) and optional status();
 * both are best-effort — a throwing adapter becomes an ERROR row, never a 500.
 * This endpoint moves no money and is independent of booking/settlement.
 */
const HEALTH_TIMEOUT_MS = 6000;

export async function GET(request: Request) {
  try {
    await requireRole(request, ["ADMIN", "SUPPORT", "FINANCE_ADMIN", "SUPER_ADMIN"] as unknown as ("ADMIN")[]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const adapters = registeredLoadBoardAdapters();

  const rows = await Promise.all(adapters.map(async (a) => {
    const inputs: HealthInputs = { providerKey: a.providerKey, featureKey: a.featureKey, apiVersion: a.apiVersion, enabled: false };
    try {
      inputs.enabled = await isFeatureEnabled(a.featureKey);
    } catch { /* enabled stays false */ }

    // Local configuration metadata — gathered ALWAYS (no network), so a
    // disabled provider still shows credentials-configured + environment.
    if (a.configurationStatus) {
      try { inputs.configuration = a.configurationStatus(); } catch { /* leave undefined */ }
    }

    // Only probe the network when the provider is enabled — a disabled
    // provider shows DISABLED without a pointless timed call.
    if (inputs.enabled) {
      const start = Date.now();
      try {
        const health = await withTimeout(a.healthCheck(), HEALTH_TIMEOUT_MS);
        inputs.health = health;
        inputs.latencyMs = Date.now() - start;
      } catch (e) {
        inputs.health = { ok: false, detail: e instanceof Error ? e.message : "health check failed/timed out" };
        inputs.latencyMs = Date.now() - start;
      }
      if (a.status) {
        try { inputs.status = await withTimeout(a.status(), HEALTH_TIMEOUT_MS); } catch { /* status stays undefined */ }
      }
    }
    return assembleHealthRow(inputs);
  }));

  return NextResponse.json({ providers: rows, checkedAt: new Date().toISOString() });
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timed out")), ms)),
  ]);
}
