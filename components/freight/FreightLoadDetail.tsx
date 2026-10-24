"use client";

import { useEffect, useState, useCallback } from "react";
import { getLoadDetail, transitionLoad, allowedTransitions, dollars, type LoadDetail, type LoadStatus } from "./freight-api";
import { DormantBanner } from "./FreightConsole";

/**
 * Freight load detail workspace — 11 tabbed sections. Correctness rules baked in:
 *  - Only backend-allowed status transitions are shown; a failed transition
 *    surfaces the backend reason + current status (never forces the UI forward).
 *  - Money is display-formatted from server integer cents (never recomputed).
 *  - POD upload and approval are visibly separate; upload ≠ delivery.
 *  - Factoring remit-to is read-only, sourced from the server active NOA.
 *  - When brokerage is dormant, action buttons are disabled and say which
 *    capability is off, not a generic error.
 */

const TABS = ["Overview", "Stops", "Financials", "Offers", "Dispatch", "Rate confirmation", "Documents", "Accessorials", "Invoice", "Settlement", "Audit"] as const;
type Tab = (typeof TABS)[number];

export default function FreightLoadDetail({ loadId }: { loadId: string }) {
  const [data, setData] = useState<LoadDetail | null>(null);
  const [tab, setTab] = useState<Tab>("Overview");
  const [error, setError] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try { setData(await getLoadDetail(loadId)); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not load."); }
  }, [loadId]);
  useEffect(() => { load(); }, [load]);

  async function doTransition(to: LoadStatus) {
    setBusy(true); setActionMsg(null);
    const reason = to === "CANCELED" || to === "EXCEPTION" ? (prompt(`Reason for ${to.toLowerCase()}?`) ?? undefined) : undefined;
    const r = await transitionLoad(loadId, to, reason);
    if (!r.ok) {
      // Surface the backend reason + current status; do NOT force the UI forward.
      setActionMsg(r.code === "DISABLED" ? `Action unavailable: ${r.error}` : r.error || "Action failed.");
    } else {
      await load();
    }
    setBusy(false);
  }

  if (error && !data) return <div className="mx-auto max-w-5xl px-6 py-10"><div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div></div>;
  if (!data) return <div className="mx-auto max-w-5xl px-6 py-10 text-sm text-slate-400">Loading…</div>;

  const { load: l, activeAssignment, brokerageActive } = data;
  const transitions = allowedTransitions(l.status);

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <a href="/admin/freight" className="text-xs text-slate-500 underline">← Back to loads</a>
      <header className="mb-4 mt-2 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">{l.commodity || "Load"} <span className="text-sm font-normal text-slate-400">{l.id.slice(0, 8)}</span></h1>
          <p className="mt-1 text-sm text-slate-500">Status: {l.status.replace(/_/g, " ")} · v{l.version}</p>
        </div>
      </header>

      {!brokerageActive && <DormantBanner />}

      {/* Transition actions — only backend-allowed ones shown */}
      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
        <span className="mr-1 text-xs font-medium text-slate-500">Move to:</span>
        {transitions.length === 0 && <span className="text-xs text-slate-400">No transitions available from {l.status.replace(/_/g, " ")}.</span>}
        {transitions.map((to) => (
          <button key={to} disabled={busy || !brokerageActive} title={!brokerageActive ? "Freight brokerage is disabled" : ""}
            onClick={() => doTransition(to)}
            className={`rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-40 ${to === "CANCELED" || to === "EXCEPTION" ? "bg-red-600 text-white" : "bg-slate-900 text-white"}`}>
            {to.replace(/_/g, " ")}
          </button>
        ))}
      </div>
      {actionMsg && <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">{actionMsg} (Current status: {l.status.replace(/_/g, " ")})</div>}

      {/* Tabs */}
      <div className="mb-4 flex flex-wrap gap-1 border-b border-slate-200">
        {TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`px-3 py-2 text-sm font-medium ${tab === t ? "border-b-2 border-slate-900 text-slate-900" : "text-slate-500 hover:text-slate-700"}`}>{t}</button>
        ))}
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-5">
        {tab === "Overview" && <Overview l={l} />}
        {tab === "Stops" && <Stops stops={l.stops} />}
        {tab === "Financials" && <Financials l={l} />}
        {tab === "Offers" && <Offers offers={l.offers} />}
        {tab === "Dispatch" && <Dispatch l={l} />}
        {tab === "Rate confirmation" && <RateCons items={l.rateConfirmations} />}
        {tab === "Documents" && <Documents />}
        {tab === "Accessorials" && <Accessorials items={l.accessorials} />}
        {tab === "Invoice" && <Invoices items={l.invoices} />}
        {tab === "Settlement" && <Settlement l={l} activeAssignment={activeAssignment} />}
        {tab === "Audit" && <Audit events={l.auditEvents} />}
      </div>
    </div>
  );
}

const row = "flex justify-between py-1 text-sm";
function Overview({ l }: { l: LoadDetail["load"] }) {
  return (
    <dl className="grid grid-cols-2 gap-x-6">
      <div className={row}><dt className="text-slate-400">Commodity</dt><dd className="text-slate-800">{l.commodity || "—"}</dd></div>
      <div className={row}><dt className="text-slate-400">Equipment</dt><dd className="text-slate-800">{l.equipmentType || "—"}</dd></div>
      <div className={row}><dt className="text-slate-400">Weight</dt><dd className="text-slate-800">{l.weightLbs ? `${l.weightLbs} lb` : "—"}</dd></div>
      <div className={row}><dt className="text-slate-400">Pallets</dt><dd className="text-slate-800">{l.palletCount ?? "—"}</dd></div>
      <div className={row}><dt className="text-slate-400">Market</dt><dd className="text-slate-800">{l.marketId || "—"}</dd></div>
      <div className={row}><dt className="text-slate-400">Assigned carrier</dt><dd className="text-slate-800">{l.assignedCarrierId ? l.assignedCarrierId.slice(0, 8) : "—"}</dd></div>
    </dl>
  );
}
function Stops({ stops }: { stops: LoadDetail["load"]["stops"] }) {
  if (!stops.length) return <p className="text-sm text-slate-400">No stops.</p>;
  return (
    <ol className="space-y-2">
      {stops.map((s) => (
        <li key={s.id} className="rounded-md border border-slate-200 p-3 text-sm">
          <span className="font-medium text-slate-800">{s.sequence}. {s.stopType}</span>
          <span className="text-slate-500"> — {[s.city, s.state, s.zip].filter(Boolean).join(", ") || "location TBD"}</span>
          {s.appointmentAt && <span className="text-xs text-slate-400"> · {new Date(s.appointmentAt).toLocaleString()}</span>}
        </li>
      ))}
    </ol>
  );
}
function Financials({ l }: { l: LoadDetail["load"] }) {
  return (
    <div className="space-y-3 text-sm">
      <p className="text-xs text-slate-400">All values are server-calculated from integer cents. The console never recomputes totals.</p>
      <table className="w-full">
        <tbody className="divide-y divide-slate-100">
          <tr><td className="py-1 text-slate-500">Customer linehaul</td><td className="py-1 text-right">{dollars(l.customerLinehaulCents)}</td><td className="py-1 pl-6 text-slate-500">Carrier linehaul</td><td className="py-1 text-right">{dollars(l.carrierLinehaulCents)}</td></tr>
          <tr><td className="py-1 text-slate-500">Customer fuel</td><td className="py-1 text-right">{dollars(l.customerFuelSurchargeCents)}</td><td className="py-1 pl-6 text-slate-500">Carrier fuel</td><td className="py-1 text-right">{dollars(l.carrierFuelSurchargeCents)}</td></tr>
          <tr><td className="py-1 text-slate-500">Customer accessorials</td><td className="py-1 text-right">{dollars(l.customerAccessorialsCents)}</td><td className="py-1 pl-6 text-slate-500">Carrier accessorials</td><td className="py-1 text-right">{dollars(l.carrierAccessorialsCents)}</td></tr>
          <tr className="font-medium"><td className="py-1 text-slate-700">Customer total</td><td className="py-1 text-right">{dollars(l.customerTotalCents)}</td><td className="py-1 pl-6 text-slate-700">Carrier total</td><td className="py-1 text-right">{dollars(l.carrierTotalCents)}</td></tr>
        </tbody>
      </table>
      <div className="flex gap-8 border-t border-slate-200 pt-2 font-medium">
        <span className="text-slate-700">Gross margin: {dollars(l.grossMarginCents)}</span>
        <span className="text-slate-700">Platform revenue: {dollars(l.platformRevenueCents)}</span>
      </div>
      {l.amendments.length > 0 && (
        <div className="mt-3"><p className="text-xs font-semibold uppercase text-slate-400">Amendment history</p>
          <ul className="mt-1 text-xs text-slate-500">{l.amendments.map((a) => <li key={a.id}>v{a.version}: cust {dollars(a.customerTotalCents)} / carrier {dollars(a.carrierTotalCents)}{a.reason ? ` — ${a.reason}` : ""}</li>)}</ul>
        </div>
      )}
    </div>
  );
}
function Offers({ offers }: { offers: LoadDetail["load"]["offers"] }) {
  if (!offers.length) return <p className="text-sm text-slate-400">No offers.</p>;
  return (
    <ul className="divide-y divide-slate-100">
      {offers.map((o) => (
        <li key={o.id} className="py-2 text-sm">
          <div className="flex justify-between">
            <span className="text-slate-800">Carrier {o.carrierId.slice(0, 8)} · {dollars(o.offeredRateCents)}</span>
            <span className={`text-xs ${o.status === "ACCEPTED" ? "text-emerald-600" : o.status === "SUPERSEDED" ? "text-slate-400" : "text-slate-500"}`}>{o.status}</span>
          </div>
          {o.declineReason && <p className="text-xs text-slate-400">Declined: {o.declineReason}</p>}
          <p className="text-xs text-slate-400">Expires {new Date(o.expiresAt).toLocaleString()}</p>
        </li>
      ))}
    </ul>
  );
}
function Dispatch({ l }: { l: LoadDetail["load"] }) {
  return (
    <div className="text-sm text-slate-600">
      <p>Assigned carrier: {l.assignedCarrierId ? l.assignedCarrierId.slice(0, 8) : "none yet"}.</p>
      <p className="mt-2 text-xs text-slate-400">Offer acceptance is a carrier action; two carriers cannot accept the same load (the backend enforces this atomically). An authorized admin override, when supported, is audited by the backend.</p>
    </div>
  );
}
function RateCons({ items }: { items: LoadDetail["load"]["rateConfirmations"] }) {
  if (!items.length) return <p className="text-sm text-slate-400">No rate confirmations generated.</p>;
  const current = items[0]; // highest version (server-ordered desc)
  return (
    <div className="text-sm">
      <div className="rounded-md border border-slate-200 p-3">
        <p className="font-medium text-slate-800">Current — v{current.version}</p>
        <p className="text-slate-600">Carrier rate: {dollars(current.agreedCarrierRateCents)}</p>
        <p className={`text-xs ${current.acceptedAt ? "text-emerald-600" : "text-amber-600"}`}>{current.acceptedAt ? `Acknowledged ${new Date(current.acceptedAt).toLocaleDateString()}` : "Awaiting carrier acknowledgment"}</p>
      </div>
      {items.length > 1 && (
        <div className="mt-3"><p className="text-xs font-semibold uppercase text-slate-400">Prior versions</p>
          <ul className="mt-1 text-xs text-slate-500">{items.slice(1).map((r) => <li key={r.id}>v{r.version}: {dollars(r.agreedCarrierRateCents)}{r.acceptedAt ? " (acknowledged)" : ""}</li>)}</ul>
        </div>
      )}
      <p className="mt-3 text-xs text-slate-400">A material change generates a new version; acknowledged confirmations are never silently overwritten.</p>
    </div>
  );
}
function Documents() {
  return (
    <div className="text-sm text-slate-600">
      <p className="font-medium text-slate-800">POD workflow</p>
      <div className="mt-2 flex items-center gap-2 text-xs">
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-600">Uploaded</span><span className="text-slate-300">→</span>
        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-amber-800">Pending approval</span><span className="text-slate-300">→</span>
        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-emerald-800">Approved</span>
        <span className="text-slate-300">/</span>
        <span className="rounded-full bg-red-100 px-2 py-0.5 text-red-800">Rejected</span>
      </div>
      <p className="mt-2 text-xs text-slate-400">Upload and approval are separate actions. Uploading a POD never marks the load delivered or completed — approval is a distinct step.</p>
    </div>
  );
}
function Accessorials({ items }: { items: LoadDetail["load"]["accessorials"] }) {
  if (!items.length) return <p className="text-sm text-slate-400">No accessorials.</p>;
  return (
    <ul className="divide-y divide-slate-100">
      {items.map((a) => (
        <li key={a.id} className="py-2 text-sm">
          <div className="flex justify-between">
            <span className="text-slate-800">{a.kind.replace(/_/g, " ")} · requested {dollars(a.requestedAmountCents)}</span>
            <span className={`text-xs ${a.approvalStatus === "APPROVED" ? "text-emerald-600" : a.approvalStatus === "REJECTED" ? "text-red-600" : "text-amber-600"}`}>{a.approvalStatus}</span>
          </div>
          <p className="text-xs text-slate-400">
            {a.approvedAmountCents !== null ? `Approved ${dollars(a.approvedAmountCents)} · ` : ""}
            {a.customerBillable ? "customer-billable " : ""}{a.carrierPayable ? "carrier-payable " : ""}
            {!a.supportingDocumentId && <span className="text-amber-600">· supporting document required before approving a billable amount</span>}
          </p>
          {a.reason && <p className="text-xs text-slate-500">{a.reason}</p>}
        </li>
      ))}
    </ul>
  );
}
function Invoices({ items }: { items: LoadDetail["load"]["invoices"] }) {
  if (!items.length) return <p className="text-sm text-slate-400">No invoices.</p>;
  return (
    <ul className="divide-y divide-slate-100">
      {items.map((i) => (
        <li key={i.id} className="flex justify-between py-2 text-sm">
          <span className="text-slate-800">#{i.invoiceNumber} · {dollars(i.totalCents)}</span>
          <span className="text-xs text-slate-500">{i.status}{i.dueDate ? ` · due ${new Date(i.dueDate).toLocaleDateString()}` : ""}</span>
        </li>
      ))}
    </ul>
  );
}
function Settlement({ l, activeAssignment }: { l: LoadDetail["load"]; activeAssignment: LoadDetail["activeAssignment"] }) {
  const s = l.settlements[0];
  return (
    <div className="space-y-3 text-sm">
      <p className="text-xs text-slate-400">Preparation is not payment. A settlement can be prepared here; payout execution stays disabled until authority + activation.</p>
      <div className="rounded-md border border-slate-200 p-3">
        <div className="flex justify-between"><span className="text-slate-500">Carrier total</span><span className="text-slate-800">{dollars(l.carrierTotalCents)}</span></div>
        <div className="flex justify-between"><span className="text-slate-500">Factoring remit-to</span><span className="text-slate-800">{activeAssignment ? `${activeAssignment.remitToName} (locked)` : "carrier direct"}</span></div>
        {activeAssignment && <p className="mt-1 text-xs text-slate-400">An active verified NOA exists — the remittance destination is read-only and server-controlled.</p>}
        <div className="mt-2 flex justify-between"><span className="text-slate-500">Settlement status</span><span className="text-slate-800">{s ? s.status : "not prepared"}</span></div>
      </div>
      <p className="text-xs text-slate-400">The backend blocks preparation when POD is unapproved, the carrier is ineligible, or a payment exception is unresolved.</p>
    </div>
  );
}
function Audit({ events }: { events: LoadDetail["load"]["auditEvents"] }) {
  if (!events.length) return <p className="text-sm text-slate-400">No audit events.</p>;
  return (
    <ul className="space-y-2">
      {events.map((e) => (
        <li key={e.id} className="border-l-2 border-slate-200 pl-3 text-sm">
          <span className="text-xs font-medium text-slate-600">{e.event.replace(/_/g, " ")}</span>
          <span className="text-xs text-slate-400"> · {new Date(e.createdAt).toLocaleString()}{e.actorId ? ` · ${e.actorId.slice(0, 8)}` : ""}</span>
        </li>
      ))}
    </ul>
  );
}
