"use client";

import { useEffect, useState, useCallback } from "react";
import { authFetch } from "@/lib/client-auth";

/**
 * Market Management — admin "mission control" for launching and operating
 * markets. Renders GET /api/admin/markets and drives stage + service-control
 * changes through PATCH /api/admin/markets WITHOUT a deploy.
 *
 * Truthfulness discipline (mirrors the backend + IntegrationHealthPanel):
 *  - Activation to ACTIVE runs the readiness check server-side; if the API
 *    returns 428 with blockers, we surface them and require an explicit
 *    override reason before retrying — we never silently override.
 *  - A market's freight-brokerage control is necessary-but-not-sufficient; the
 *    UI states plainly that it cannot override the global compliance flags.
 */

const STAGES = ["PLANNING", "CARRIER_RECRUITMENT", "COMING_SOON", "SOFT_LAUNCH", "ACTIVE", "PAUSED", "CLOSED"] as const;
type Stage = (typeof STAGES)[number];

const SERVICE_CONTROLS = [
  { key: "customerBookingEnabled", label: "Customer booking" },
  { key: "moverRecruitmentEnabled", label: "Mover recruitment" },
  { key: "driverRecruitmentEnabled", label: "Driver recruitment" },
  { key: "carrierRecruitmentEnabled", label: "Carrier recruitment" },
  { key: "dispatchSupportEnabled", label: "Dispatch support" },
  { key: "freightBrokerageEnabled", label: "Freight brokerage" },
  { key: "junkRemovalEnabled", label: "Junk removal" }, // Junk removal — VASRUE Digital Media, 28 Oct 2026.
] as const;

type Market = {
  id: string;
  name: string;
  state: string;
  stage: Stage;
  customerBookingEnabled: boolean;
  moverRecruitmentEnabled: boolean;
  driverRecruitmentEnabled: boolean;
  carrierRecruitmentEnabled: boolean;
  dispatchSupportEnabled: boolean;
  freightBrokerageEnabled: boolean;
  junkRemovalEnabled: boolean;
};

const STAGE_STYLES: Record<Stage, string> = {
  PLANNING: "bg-slate-100 text-slate-700",
  CARRIER_RECRUITMENT: "bg-indigo-100 text-indigo-800",
  COMING_SOON: "bg-amber-100 text-amber-800",
  SOFT_LAUNCH: "bg-sky-100 text-sky-800",
  ACTIVE: "bg-emerald-100 text-emerald-800",
  PAUSED: "bg-orange-100 text-orange-800",
  CLOSED: "bg-slate-200 text-slate-500",
};

export default function MarketManagementPanel() {
  const [markets, setMarkets] = useState<Market[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Market | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await authFetch("/api/admin/markets");
      if (!res.ok) { setError(`Could not load markets (${res.status}).`); return; }
      const data = await res.json();
      setMarkets(data.markets ?? []);
    } catch {
      setError("Could not reach the markets service.");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-900">Market Management</h1>
        <p className="mt-1 text-sm text-slate-500">
          Launch control for every market. Stage and service changes take effect without a deploy.
          Freight brokerage stays off platform-wide until authority is confirmed — a market setting can never override that.
        </p>
      </header>

      {error && (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error} <button onClick={load} className="ml-2 underline">Retry</button>
        </div>
      )}

      {markets === null && !error && <p className="text-sm text-slate-400">Loading markets…</p>}
      {markets?.length === 0 && <p className="text-sm text-slate-400">No markets configured yet.</p>}

      {markets && markets.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-slate-200">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Market</th>
                <th className="px-4 py-3">Stage</th>
                <th className="px-4 py-3">Active services</th>
                <th className="px-4 py-3 text-right">Manage</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {markets.map((m) => {
                const activeServices = SERVICE_CONTROLS.filter((s) => m[s.key]).map((s) => s.label);
                return (
                  <tr key={m.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-900">{m.name}</div>
                      <div className="text-xs text-slate-400">{m.state}</div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${STAGE_STYLES[m.stage]}`}>
                        {m.stage.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {activeServices.length ? activeServices.join(", ") : <span className="text-slate-400">None enabled</span>}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button onClick={() => setSelected(m)} className="rounded-md border border-slate-300 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100">
                        Manage
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <MarketEditor market={selected} onClose={() => setSelected(null)} onSaved={() => { setSelected(null); load(); }} />
      )}
    </div>
  );
}

function MarketEditor({ market, onClose, onSaved }: { market: Market; onClose: () => void; onSaved: () => void }) {
  const [stage, setStage] = useState<Stage>(market.stage);
  const [services, setServices] = useState(() =>
    Object.fromEntries(SERVICE_CONTROLS.map((s) => [s.key, market[s.key]])) as Record<string, boolean>
  );
  const [blockers, setBlockers] = useState<string[] | null>(null);
  const [overrideReason, setOverrideReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const activatingToActive = stage === "ACTIVE" && market.stage !== "ACTIVE";

  async function save(withOverride: boolean) {
    setSaving(true); setSaveError(null);
    try {
      const body: Record<string, unknown> = { marketId: market.id, stage, ...services };
      if (withOverride) { body.override = true; body.reason = overrideReason; }
      const res = await authFetch("/api/admin/markets", { method: "PATCH", body: JSON.stringify(body) });
      if (res.status === 428) {
        const data = await res.json();
        setBlockers(data.blockers ?? ["Market is not ready to activate."]);
        return;
      }
      if (!res.ok) { setSaveError(`Save failed (${res.status}).`); return; }
      onSaved();
    } catch {
      setSaveError("Could not reach the markets service.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-lg bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold text-slate-900">{market.name} <span className="text-sm font-normal text-slate-400">· {market.state}</span></h2>

        <label className="mt-4 block text-sm font-medium text-slate-700">Stage</label>
        <select value={stage} onChange={(e) => { setStage(e.target.value as Stage); setBlockers(null); }}
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm">
          {STAGES.map((s) => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}
        </select>

        <fieldset className="mt-4">
          <legend className="text-sm font-medium text-slate-700">Service controls</legend>
          <p className="mb-2 text-xs text-slate-400">A market being ACTIVE does not enable any service on its own.</p>
          <div className="space-y-2">
            {SERVICE_CONTROLS.map((s) => (
              <label key={s.key} className="flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" checked={services[s.key]} onChange={(e) => setServices((prev) => ({ ...prev, [s.key]: e.target.checked }))} />
                {s.label}
                {s.key === "freightBrokerageEnabled" && (
                  <span className="text-xs text-slate-400">(inert until global brokerage authority is active)</span>
                )}
              </label>
            ))}
          </div>
        </fieldset>

        {activatingToActive && (
          <p className="mt-4 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Activating a market runs a readiness check. If requirements are unmet you will be asked to confirm with a reason.
          </p>
        )}

        {blockers && (
          <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-3">
            <p className="text-sm font-medium text-amber-800">This market is not ready to activate:</p>
            <ul className="mt-1 list-disc pl-5 text-xs text-amber-700">
              {blockers.map((b, i) => <li key={i}>{b}</li>)}
            </ul>
            <label className="mt-3 block text-xs font-medium text-amber-800">Override reason (required to proceed)</label>
            <textarea value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} rows={2}
              className="mt-1 w-full rounded-md border border-amber-300 px-2 py-1 text-sm" placeholder="Why activate despite the blockers?" />
            <button disabled={!overrideReason.trim() || saving} onClick={() => save(true)}
              className="mt-2 rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
              Override and activate
            </button>
          </div>
        )}

        {saveError && <p className="mt-3 text-sm text-red-600">{saveError}</p>}

        <div className="mt-6 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-md border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50">Cancel</button>
          <button disabled={saving} onClick={() => save(false)} className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  );
}
