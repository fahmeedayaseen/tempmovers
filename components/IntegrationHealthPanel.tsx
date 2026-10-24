"use client";

import { useEffect, useState, useCallback } from "react";
import { authFetch } from "@/lib/client-auth";

/**
 * Integration Health panel — thin, admin-only, READ-ONLY operational view.
 * Renders exactly what GET /api/admin/integrations/health returns, plus a
 * per-provider Test Connection action (POST .../test-connection). No mock
 * data, no persisted history, no charts, no alerts — those are post-launch.
 *
 * Truthfulness rule (mirrors the backend): never fabricate a status or a
 * timestamp. A field the backend reports as null renders as an explicit
 * "Not tracked" / "Unknown" / "Unavailable until enabled" — never a guess.
 */

type HealthRow = {
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
  credentialExpired: boolean | null;
};

const STATE_BADGE: Record<HealthRow["state"], { label: string; cls: string }> = {
  CONNECTED: { label: "Connected", cls: "bg-green-100 text-green-800 border-green-200" },
  DISCONNECTED: { label: "Disconnected", cls: "bg-amber-100 text-amber-800 border-amber-200" },
  ERROR: { label: "Error", cls: "bg-red-100 text-red-800 border-red-200" },
  DISABLED: { label: "Disabled", cls: "bg-gray-100 text-gray-600 border-gray-200" },
};

const CONFIG_LABEL: Record<HealthRow["configStatus"], string> = {
  CONFIGURED: "Credentials configured",
  MISSING_CREDENTIALS: "Missing credentials",
  UNKNOWN: "Unknown",
};

/** Render a value that may be null, with a truthful placeholder. */
function orNotTracked(value: string | number | null | undefined, placeholder = "Not tracked") {
  return value === null || value === undefined || value === "" ? (
    <span className="text-gray-400 italic">{placeholder}</span>
  ) : (
    <span>{value}</span>
  );
}

export default function IntegrationHealthPanel() {
  const [rows, setRows] = useState<HealthRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  const [testResult, setTestResult] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await authFetch("/api/admin/integrations/health");
      if (!res.ok) throw new Error(`Failed to load integration health (HTTP ${res.status}).`);
      const data = await res.json();
      setRows(data.providers ?? []);
      setCheckedAt(data.checkedAt ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load integration health.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function testConnection(providerKey: string) {
    setTesting((t) => ({ ...t, [providerKey]: true }));
    setTestResult((r) => ({ ...r, [providerKey]: "" }));
    try {
      const res = await authFetch("/api/admin/integrations/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerKey }),
      });
      const data = await res.json();
      if (!res.ok) {
        setTestResult((r) => ({ ...r, [providerKey]: data.error ?? `HTTP ${res.status}` }));
      } else {
        const row: HealthRow = data.result;
        setTestResult((r) => ({ ...r, [providerKey]: `${STATE_BADGE[row.state].label}${row.latencyMs != null ? ` · ${row.latencyMs}ms` : ""}${row.lastError ? ` · ${row.lastError}` : ""}` }));
        // Merge the fresh result into the row so the table reflects it.
        setRows((rs) => rs.map((r) => (r.providerKey === providerKey ? row : r)));
      }
    } catch (e) {
      setTestResult((r) => ({ ...r, [providerKey]: e instanceof Error ? e.message : "Test failed." }));
    } finally {
      setTesting((t) => ({ ...t, [providerKey]: false }));
    }
  }

  if (loading) return <div className="p-6 text-gray-500">Loading integration health…</div>;
  if (error) return (
    <div className="p-6">
      <p className="text-red-700">{error}</p>
      <button onClick={load} className="mt-3 rounded border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50">Retry</button>
    </div>
  );

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Integration Health</h2>
          <p className="text-sm text-gray-500">
            Read-only. Live check {checkedAt ? `at ${new Date(checkedAt).toLocaleString()}` : "—"}.
          </p>
        </div>
        <button onClick={load} className="rounded border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50">Refresh</button>
      </div>

      {rows.length === 0 ? (
        <p className="text-gray-500">No integrations registered.</p>
      ) : (
        <div className="space-y-4">
          {rows.map((r) => {
            const badge = STATE_BADGE[r.state];
            return (
              <div key={r.providerKey} className="rounded-lg border border-gray-200 p-4">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-gray-900">{r.providerKey}</span>
                      <span className={`rounded border px-2 py-0.5 text-xs font-medium ${badge.cls}`}>{badge.label}</span>
                      <span className="text-xs text-gray-500">{r.enabled ? "Enabled" : "Disabled"}</span>
                    </div>
                    <div className="mt-1 text-xs text-gray-500">Flag: {r.featureKey}</div>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <button
                      onClick={() => testConnection(r.providerKey)}
                      disabled={testing[r.providerKey]}
                      className="rounded bg-gray-900 px-3 py-1.5 text-sm text-white hover:bg-gray-700 disabled:opacity-50"
                    >
                      {testing[r.providerKey] ? "Testing…" : "Test Connection"}
                    </button>
                    {testResult[r.providerKey] ? (
                      <span className="max-w-[16rem] text-right text-xs text-gray-600">{testResult[r.providerKey]}</span>
                    ) : null}
                  </div>
                </div>

                <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
                  <Field label="Environment">{orNotTracked(r.environment, "Unknown")}</Field>
                  <Field label="Credentials">{CONFIG_LABEL[r.configStatus]}</Field>
                  <Field label="API version">{orNotTracked(r.apiVersion)}</Field>
                  <Field label="Latency">{r.latencyMs != null ? `${r.latencyMs} ms` : orNotTracked(null, r.enabled ? "Unknown" : "Unavailable until enabled")}</Field>
                  <Field label="Last error">{orNotTracked(r.lastError, "None reported")}</Field>
                  <Field label="Credential expiry">
                    {r.credentialExpiresAt
                      ? `${new Date(r.credentialExpiresAt).toLocaleDateString()}${r.credentialExpired ? " (expired)" : ""}`
                      : orNotTracked(null)}
                  </Field>
                </dl>
              </div>
            );
          })}
        </div>
      )}

      <p className="mt-4 text-xs text-gray-400">
        Historical metrics (last sync, response codes, consecutive failures) are not tracked yet and appear as “Not tracked”. This view performs a live check only; it does not store history.
      </p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-gray-400">{label}</dt>
      <dd className="text-gray-900">{children}</dd>
    </div>
  );
}
