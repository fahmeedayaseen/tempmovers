"use client";

import { useEffect, useState, useCallback } from "react";
import {
  getAssignedCarriers, getDispatcherDashboard, getCarrierLoads, dollars,
  type AssignedCarrier, type DispatcherDashboard, type DispatcherLoadRow, type DispatcherPermission,
} from "./dispatcher-api";

/**
 * Dispatcher Portal shell — carrier switcher + dashboard + per-carrier load
 * board. For dispatch offices managing multiple carriers, the switcher and the
 * permission boundary are the whole point: the dispatcher only ever sees
 * carriers that granted access, and only the permissions each granted.
 *
 * Dispatch-support views (carriers, profile, document/insurance alerts) are
 * launch-safe. Brokered load actions obey the brokerage gate (enforced
 * server-side); the UI reflects that state.
 */

function permits(carrier: AssignedCarrier | null, p: DispatcherPermission): boolean {
  return !!carrier?.permissions.includes(p);
}

export default function DispatcherPortal() {
  const [carriers, setCarriers] = useState<AssignedCarrier[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dash, setDash] = useState<DispatcherDashboard | null>(null);
  const [loads, setLoads] = useState<DispatcherLoadRow[] | null>(null);
  const [brokerageActive, setBrokerageActive] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadCarriers = useCallback(async () => {
    setError(null);
    try {
      const list = await getAssignedCarriers();
      setCarriers(list);
      if (list.length && !selectedId) setSelectedId(list[0].id);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load carriers."); }
  }, [selectedId]);

  useEffect(() => { loadCarriers(); }, [loadCarriers]);
  useEffect(() => { getDispatcherDashboard().then(setDash).catch(() => {}); }, []);
  useEffect(() => {
    if (!selectedId) { setLoads(null); return; }
    getCarrierLoads(selectedId).then((r) => { setLoads(r.loads); setBrokerageActive(r.brokerageActive); }).catch((e) => setError(e instanceof Error ? e.message : "Could not load loads."));
  }, [selectedId]);

  const selected = carriers?.find((c) => c.id === selectedId) ?? null;

  if (carriers === null && !error) return <div className="mx-auto max-w-6xl px-6 py-10 text-sm text-slate-400">Loading…</div>;
  if (carriers && carriers.length === 0) return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="text-2xl font-semibold text-slate-900">Dispatcher portal</h1>
      <p className="mt-3 text-sm text-slate-500">No carriers have granted you access yet. When a carrier authorizes you, they'll appear here with the permissions they granted.</p>
    </div>
  );

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Dispatcher portal</h1>
          <p className="mt-1 text-sm text-slate-500">Managing {carriers?.length} authorized {carriers?.length === 1 ? "carrier" : "carriers"}.</p>
        </div>
        {/* Carrier switcher */}
        <div>
          <label className="text-xs text-slate-400">Carrier</label>
          <select value={selectedId ?? ""} onChange={(e) => setSelectedId(e.target.value)} className="ml-2 rounded-md border border-slate-300 px-3 py-2 text-sm">
            {carriers?.map((c) => <option key={c.id} value={c.id}>{c.legalBusinessName}</option>)}
          </select>
        </div>
      </header>

      {error && <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      {!brokerageActive && (
        <div className="mb-6 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-800">
          Brokered load actions (offer response, status updates) are currently disabled while freight brokerage is not active. Carrier management, documents, and profile access remain available.
        </div>
      )}

      {/* Dashboard tiles (across all authorized carriers) */}
      {dash && (
        <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Tile label="Active / in transit" value={dash.activeInTransit} />
          <Tile label="Today's stops" value={dash.todaysStops} />
          <Tile label="Missing POD" value={dash.missingPod} danger />
          <Tile label="Insurance/doc warnings" value={dash.insuranceWarnings} danger />
        </div>
      )}

      {/* Selected carrier context + permissions */}
      {selected && (
        <div className="mb-4 rounded-lg border border-slate-200 bg-white p-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-medium text-slate-900">{selected.legalBusinessName}</h2>
              <p className="text-xs text-slate-400">DOT {selected.dotNumber || "—"} · MC {selected.mcNumber || "—"} · {selected.status.replace(/_/g, " ")}</p>
            </div>
            <div className="flex flex-wrap gap-1">
              {selected.permissions.map((p) => <span key={p} className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{p.replace(/_/g, " ").toLowerCase()}</span>)}
            </div>
          </div>
          {selected.accessExpiresAt && <p className="mt-2 text-xs text-amber-600">Access expires {new Date(selected.accessExpiresAt).toLocaleDateString()}</p>}
        </div>
      )}

      {/* Dispatch board for the selected carrier */}
      {!permits(selected, "VIEW_LOADS") ? (
        <p className="text-sm text-slate-400">This carrier hasn't granted you load visibility.</p>
      ) : loads === null ? <p className="text-sm text-slate-400">Loading loads…</p> : loads.length === 0 ? (
        <p className="text-sm text-slate-400">No active loads for this carrier.</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-slate-200">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr><th className="px-4 py-3">Load</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Next stop</th><th className="px-4 py-3">Carrier pay</th><th className="px-4 py-3 text-right">Open</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loads.map((l) => {
                const next = l.stops.find((s) => s.appointmentAt) ?? l.stops[0];
                return (
                  <tr key={l.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3"><div className="font-medium text-slate-900">{l.commodity || "Load"}</div><div className="text-xs text-slate-400">{l.equipmentType || ""} · {l.id.slice(0, 8)}</div></td>
                    <td className="px-4 py-3"><span className="inline-block rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700">{l.status.replace(/_/g, " ")}</span></td>
                    <td className="px-4 py-3 text-slate-600">{next ? `${next.stopType} — ${[next.city, next.state].filter(Boolean).join(", ")}` : "—"}</td>
                    <td className="px-4 py-3 text-slate-700">{dollars(l.carrierTotalCents)}</td>
                    <td className="px-4 py-3 text-right"><a href={`/dispatcher/loads/${l.id}`} className="rounded-md border border-slate-300 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100">Open</a></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Tile({ label, value, danger }: { label: string; value: number; danger?: boolean }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <p className="text-xs text-slate-400">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${danger && value > 0 ? "text-red-600" : "text-slate-900"}`}>{value}</p>
    </div>
  );
}
