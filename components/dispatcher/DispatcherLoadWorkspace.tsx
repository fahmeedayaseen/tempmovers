"use client";

import { useEffect, useState, useCallback } from "react";
import { getDispatcherLoad, updateLoadStatus, getAssignedCarriers, dollars, type DispatcherLoadDetail, type DispatcherPermission } from "./dispatcher-api";

/**
 * Dispatcher load workspace. Operational focus: stops, milestone updates,
 * offers (view), rate-confirmation status (read-only), settlement status
 * (read-only). What's intentionally absent: margin internals, factoring
 * documents, payment-routing controls, compliance/audit-admin data.
 *
 * Rate-confirmation acknowledgment is NOT offered here — binding the carrier
 * contractually is reserved for the signer role the agreements authorize, not
 * every dispatcher. Dispatchers see acknowledgment status only.
 */

const MILESTONES = ["AT_PICKUP", "LOADED", "IN_TRANSIT", "AT_DELIVERY", "DELIVERED", "POD_PENDING"] as const;

export default function DispatcherLoadWorkspace({ loadId }: { loadId: string }) {
  const [data, setData] = useState<DispatcherLoadDetail | null>(null);
  const [permissions, setPermissions] = useState<DispatcherPermission[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const d = await getDispatcherLoad(loadId);
      setData(d);
      // Resolve this dispatcher's permissions for the load's carrier (for UI gating).
      const carriers = await getAssignedCarriers();
      const c = carriers.find((x) => x.id === d.load.assignedCarrierId);
      setPermissions(c?.permissions ?? []);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load."); }
  }, [loadId]);
  useEffect(() => { load(); }, [load]);

  async function milestone(to: string) {
    setBusy(true); setMsg(null);
    const reason = to === "EXCEPTION" ? (prompt("Reason?") ?? undefined) : undefined;
    const r = await updateLoadStatus(loadId, to, reason);
    if (!r.ok) setMsg(r.code === "DENIED" ? `Not permitted: ${r.error}` : `${r.error}${r.currentStatus ? ` (current: ${r.currentStatus.replace(/_/g, " ")})` : ""}`);
    else await load();
    setBusy(false);
  }

  if (error && !data) return <div className="mx-auto max-w-4xl px-6 py-10"><div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div></div>;
  if (!data) return <div className="mx-auto max-w-4xl px-6 py-10 text-sm text-slate-400">Loading…</div>;

  const { load: l, brokerageActive } = data;
  const canUpdate = permissions.includes("UPDATE_LOAD_STATUS");
  const canSettlement = permissions.includes("VIEW_SETTLEMENT_STATUS");
  const currentRateCon = l.rateConfirmations[0];

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <a href="/dispatcher" className="text-xs text-slate-500 underline">← Back to dispatch board</a>
      <header className="mb-4 mt-2">
        <h1 className="text-2xl font-semibold text-slate-900">{l.commodity || "Load"} <span className="text-sm font-normal text-slate-400">{l.id.slice(0, 8)}</span></h1>
        <p className="mt-1 text-sm text-slate-500">Status: {l.status.replace(/_/g, " ")}</p>
      </header>

      {/* Milestone updates */}
      <section className="mb-6 rounded-lg border border-slate-200 bg-slate-50 p-4">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Update milestone</h3>
        {!canUpdate ? (
          <p className="text-xs text-slate-400">This carrier hasn't granted you status-update permission.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {MILESTONES.map((m) => (
              <button key={m} disabled={busy || !brokerageActive} title={!brokerageActive ? "Brokered actions are disabled while brokerage is inactive" : ""}
                onClick={() => milestone(m)} className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40">{m.replace(/_/g, " ")}</button>
            ))}
            <button disabled={busy || !brokerageActive} onClick={() => milestone("EXCEPTION")} className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40">Flag exception</button>
          </div>
        )}
        {!brokerageActive && canUpdate && <p className="mt-2 text-xs text-amber-600">Brokered load actions are disabled while freight brokerage is not active.</p>}
        {msg && <p className="mt-2 rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">{msg}</p>}
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Stops</h3>
          {l.stops.length ? (
            <ol className="space-y-2 text-sm">
              {l.stops.map((s) => (
                <li key={s.sequence} className="text-slate-700">{s.sequence}. {s.stopType} — {[s.city, s.state].filter(Boolean).join(", ") || "TBD"}{s.appointmentAt ? ` · ${new Date(s.appointmentAt).toLocaleString()}` : ""}</li>
              ))}
            </ol>
          ) : <p className="text-sm text-slate-400">No stops.</p>}
        </section>

        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Rate confirmation</h3>
          {currentRateCon ? (
            <div className="text-sm">
              <p className="text-slate-700">v{currentRateCon.version} · {dollars(currentRateCon.agreedCarrierRateCents)}</p>
              <p className={`text-xs ${currentRateCon.acceptedAt ? "text-emerald-600" : "text-amber-600"}`}>{currentRateCon.acceptedAt ? "Acknowledged by carrier" : "Awaiting carrier acknowledgment"}</p>
              <p className="mt-2 text-xs text-slate-400">Acknowledgment is handled by the carrier's authorized signer, not the dispatcher.</p>
            </div>
          ) : <p className="text-sm text-slate-400">No rate confirmation yet.</p>}
        </section>

        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Offers</h3>
          {l.offers.length ? (
            <ul className="space-y-1 text-sm">
              {l.offers.map((o) => (
                <li key={o.id} className="text-slate-700">{dollars(o.offeredRateCents)} · <span className={o.status === "ACCEPTED" ? "text-emerald-600" : "text-slate-500"}>{o.status}</span>{o.declineReason ? ` (${o.declineReason})` : ""}</li>
              ))}
            </ul>
          ) : <p className="text-sm text-slate-400">No offers.</p>}
        </section>

        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Settlement status</h3>
          {!canSettlement ? (
            <p className="text-sm text-slate-400">Not granted settlement visibility.</p>
          ) : l.settlements.length ? (
            <p className="text-sm text-slate-700">{l.settlements[0].status}</p>
          ) : <p className="text-sm text-slate-400">No settlement yet.</p>}
          <p className="mt-2 text-xs text-slate-400">Read-only. Payment routing and payout are not dispatcher functions.</p>
        </section>
      </div>
    </div>
  );
}
