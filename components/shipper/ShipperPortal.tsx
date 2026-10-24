"use client";

import { useEffect, useState, useCallback } from "react";
import {
  getShipperDashboard, getShipperLoads, getShipperInvoices, submitQuoteRequest, dollars,
  type ShipperDashboard, type ShipperLoadRow, type ShipperInvoice, type ShipperStatus,
} from "./shipper-api";

/**
 * Shipper Portal. Nine sections via tabs. The shipper sees only their own
 * shipments and only the customer transportation price — never carrier pay or
 * broker margin (enforced server-side by the shipper-safe read contracts).
 */

const TABS = ["Dashboard", "Request a shipment", "Quotes", "Active loads", "Delivered loads", "Invoices", "Support", "Account"] as const;
type Tab = (typeof TABS)[number];

const STATUS_STYLE: Record<ShipperStatus, string> = {
  REQUESTED: "bg-slate-100 text-slate-600", QUOTED: "bg-sky-100 text-sky-800", BOOKED: "bg-indigo-100 text-indigo-800",
  SCHEDULED: "bg-violet-100 text-violet-800", IN_TRANSIT: "bg-amber-100 text-amber-800", DELIVERED: "bg-emerald-100 text-emerald-800",
  COMPLETED: "bg-emerald-100 text-emerald-800", INVOICED: "bg-blue-100 text-blue-800", PAID: "bg-emerald-100 text-emerald-800", EXCEPTION: "bg-red-100 text-red-800",
};

export function StatusBadge({ status }: { status: ShipperStatus }) {
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[status]}`}>{status.replace(/_/g, " ")}</span>;
}

export default function ShipperPortal() {
  const [tab, setTab] = useState<Tab>("Dashboard");
  const [dash, setDash] = useState<ShipperDashboard | null>(null);
  const [loads, setLoads] = useState<ShipperLoadRow[] | null>(null);
  const [invoices, setInvoices] = useState<ShipperInvoice[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [d, l, i] = await Promise.all([getShipperDashboard(), getShipperLoads(), getShipperInvoices()]);
      setDash(d); setLoads(l); setInvoices(i);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load your portal."); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const active = loads?.filter((l) => ["BOOKED", "SCHEDULED", "IN_TRANSIT", "QUOTED", "REQUESTED"].includes(l.shipperStatus)) ?? [];
  const delivered = loads?.filter((l) => ["DELIVERED", "COMPLETED", "INVOICED", "PAID"].includes(l.shipperStatus)) ?? [];

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-900">Shipping portal</h1>
        <p className="mt-1 text-sm text-slate-500">Request shipments, track loads, and manage invoices.</p>
      </header>

      <div className="mb-6 flex flex-wrap gap-1 border-b border-slate-200">
        {TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`px-3 py-2 text-sm font-medium ${tab === t ? "border-b-2 border-slate-900 text-slate-900" : "text-slate-500 hover:text-slate-700"}`}>{t}</button>
        ))}
      </div>

      {error && <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      {tab === "Dashboard" && <Dashboard dash={dash} loads={loads} />}
      {tab === "Request a shipment" && <RequestShipment onDone={load} />}
      {tab === "Quotes" && <LoadTable rows={loads?.filter((l) => l.shipperStatus === "QUOTED") ?? null} empty="No quotes yet." />}
      {tab === "Active loads" && <LoadTable rows={active} empty="No active loads." />}
      {tab === "Delivered loads" && <LoadTable rows={delivered} empty="No delivered loads yet." />}
      {tab === "Invoices" && <Invoices invoices={invoices} />}
      {tab === "Support" && <Support />}
      {tab === "Account" && <Account />}
    </div>
  );
}

function Dashboard({ dash, loads }: { dash: ShipperDashboard | null; loads: ShipperLoadRow[] | null }) {
  if (!dash) return <p className="text-sm text-slate-400">Loading…</p>;
  const recent = loads?.slice(0, 5) ?? [];
  return (
    <div>
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3">
        <Tile label="Active loads" value={dash.activeLoads} />
        <Tile label="Delivered" value={dash.deliveredLoads} />
        <Tile label="Open invoices" value={dash.openInvoices} danger />
      </div>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Recent shipments</h3>
      <LoadTable rows={recent} empty="No shipments yet. Use 'Request a shipment' to get started." />
    </div>
  );
}

function Tile({ label, value, danger }: { label: string; value: number; danger?: boolean }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <p className="text-xs text-slate-400">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${danger && value > 0 ? "text-amber-600" : "text-slate-900"}`}>{value}</p>
    </div>
  );
}

function LoadTable({ rows, empty }: { rows: ShipperLoadRow[] | null; empty: string }) {
  if (rows === null) return <p className="text-sm text-slate-400">Loading…</p>;
  if (rows.length === 0) return <p className="text-sm text-slate-400">{empty}</p>;
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200">
      <table className="w-full text-left text-sm">
        <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
          <tr><th className="px-4 py-3">Shipment</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Price</th><th className="px-4 py-3 text-right">Track</th></tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((l) => (
            <tr key={l.id} className="hover:bg-slate-50">
              <td className="px-4 py-3"><div className="font-medium text-slate-900">{l.commodity || "Shipment"}</div><div className="text-xs text-slate-400">{l.equipmentType || ""} · {l.id.slice(0, 8)}</div></td>
              <td className="px-4 py-3"><StatusBadge status={l.shipperStatus} /></td>
              <td className="px-4 py-3 text-slate-700">{dollars(l.customerTotalCents)}</td>
              <td className="px-4 py-3 text-right"><a href={`/shipper/loads/${l.id}`} className="rounded-md border border-slate-300 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100">Track</a></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RequestShipment({ onDone }: { onDone: () => void }) {
  const [form, setForm] = useState({ originCity: "", originState: "", destinationCity: "", destinationState: "", equipmentType: "", commodity: "", weightLbs: "", palletCount: "", pickupDate: "", deliveryDate: "", notes: "" });
  const [result, setResult] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const input = "w-full rounded-md border border-slate-300 px-3 py-2 text-sm";

  async function submit() {
    setSaving(true); setResult(null);
    try {
      const payload: Record<string, unknown> = { ...form, weightLbs: form.weightLbs ? parseInt(form.weightLbs) : undefined, palletCount: form.palletCount ? parseInt(form.palletCount) : undefined };
      const r = await submitQuoteRequest(payload);
      setResult(r.message);
      onDone();
    } catch (e) { setResult(e instanceof Error ? e.message : "Could not submit."); }
    finally { setSaving(false); }
  }

  return (
    <div className="max-w-2xl">
      <h2 className="mb-1 text-lg font-semibold text-slate-900">Request a shipment</h2>
      <p className="mb-4 text-xs text-slate-400">Tell us about your shipment and we'll follow up with a transportation quote. Submitting a request doesn't book capacity.</p>
      <div className="grid grid-cols-2 gap-3">
        <input className={input} placeholder="Origin city" value={form.originCity} onChange={(e) => setForm({ ...form, originCity: e.target.value })} />
        <input className={input} placeholder="Origin state" value={form.originState} onChange={(e) => setForm({ ...form, originState: e.target.value.toUpperCase() })} />
        <input className={input} placeholder="Destination city" value={form.destinationCity} onChange={(e) => setForm({ ...form, destinationCity: e.target.value })} />
        <input className={input} placeholder="Destination state" value={form.destinationState} onChange={(e) => setForm({ ...form, destinationState: e.target.value.toUpperCase() })} />
        <input className={input} placeholder="Equipment (e.g. dry van, reefer)" value={form.equipmentType} onChange={(e) => setForm({ ...form, equipmentType: e.target.value })} />
        <input className={input} placeholder="Commodity" value={form.commodity} onChange={(e) => setForm({ ...form, commodity: e.target.value })} />
        <input className={input} placeholder="Weight (lb)" value={form.weightLbs} onChange={(e) => setForm({ ...form, weightLbs: e.target.value })} />
        <input className={input} placeholder="Pallet count" value={form.palletCount} onChange={(e) => setForm({ ...form, palletCount: e.target.value })} />
        <label className="text-xs text-slate-500">Pickup<input className={input} type="date" value={form.pickupDate} onChange={(e) => setForm({ ...form, pickupDate: e.target.value })} /></label>
        <label className="text-xs text-slate-500">Delivery<input className={input} type="date" value={form.deliveryDate} onChange={(e) => setForm({ ...form, deliveryDate: e.target.value })} /></label>
      </div>
      <textarea className={`${input} mt-3`} placeholder="Notes (access, appointment requirements, etc.)" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
      <button onClick={submit} disabled={saving} className="mt-3 rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{saving ? "Submitting…" : "Submit request"}</button>
      {result && <p className="mt-3 rounded-md bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{result}</p>}
    </div>
  );
}

function Invoices({ invoices }: { invoices: ShipperInvoice[] | null }) {
  if (invoices === null) return <p className="text-sm text-slate-400">Loading…</p>;
  if (invoices.length === 0) return <p className="text-sm text-slate-400">No invoices yet.</p>;
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200">
      <table className="w-full text-left text-sm">
        <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
          <tr><th className="px-4 py-3">Invoice</th><th className="px-4 py-3">Total</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Due</th></tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {invoices.map((i) => (
            <tr key={i.id} className="hover:bg-slate-50">
              <td className="px-4 py-3 font-medium text-slate-900">#{i.invoiceNumber}</td>
              <td className="px-4 py-3 text-slate-700">{dollars(i.totalCents)}</td>
              <td className="px-4 py-3"><span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{i.status}</span></td>
              <td className="px-4 py-3 text-slate-500">{i.dueDate ? new Date(i.dueDate).toLocaleDateString() : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Support() {
  return (
    <div className="max-w-xl">
      <h2 className="mb-1 text-lg font-semibold text-slate-900">Support & disputes</h2>
      <p className="text-sm text-slate-500">Need help with a shipment or invoice? Open a support request and our team will follow up. Disputes on a specific invoice can be raised from that invoice.</p>
      <a href="mailto:support@tempmovers.example" className="mt-3 inline-block rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white">Contact support</a>
    </div>
  );
}

function Account() {
  return (
    <div className="max-w-xl">
      <h2 className="mb-1 text-lg font-semibold text-slate-900">Account & settings</h2>
      <p className="text-sm text-slate-500">Manage your company profile, billing contact, and notification preferences.</p>
      <a href="/account" className="mt-3 inline-block rounded-md border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50">Open account settings</a>
    </div>
  );
}
