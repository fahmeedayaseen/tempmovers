"use client";

import { useEffect, useState, useCallback } from "react";
import { getShipperLoad, dollars, type ShipperLoadDetail } from "./shipper-api";
import { StatusBadge } from "./ShipperPortal";

/**
 * Shipment tracking detail (shipper-facing). Shows business status, stops, the
 * customer transportation price breakdown, carrier name (only at the
 * appropriate stage), POD availability, customer-billable accessorials, and
 * invoices. No carrier pay, margin, offers, factoring, or audit data — the
 * server never sends them.
 */
export default function ShipperLoadTracking({ loadId }: { loadId: string }) {
  const [data, setData] = useState<ShipperLoadDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try { setData(await getShipperLoad(loadId)); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not load shipment."); }
  }, [loadId]);
  useEffect(() => { load(); }, [load]);

  if (error) return <div className="mx-auto max-w-3xl px-6 py-10"><div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div></div>;
  if (!data) return <div className="mx-auto max-w-3xl px-6 py-10 text-sm text-slate-400">Loading…</div>;

  const { load: l, carrierName, podAvailable } = data;

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <a href="/shipper" className="text-xs text-slate-500 underline">← Back to portal</a>
      <header className="mb-6 mt-2 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">{l.commodity || "Shipment"}</h1>
          <p className="mt-1 text-sm text-slate-500">{l.equipmentType || ""} · {l.id.slice(0, 8)}</p>
        </div>
        <StatusBadge status={l.shipperStatus} />
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Route</h3>
          {l.stops.length ? (
            <ol className="space-y-2 text-sm">
              {l.stops.map((s) => (
                <li key={s.sequence} className="text-slate-700">{s.sequence}. {s.stopType} — {[s.city, s.state, s.zip].filter(Boolean).join(", ") || "TBD"}{s.appointmentAt ? ` · ${new Date(s.appointmentAt).toLocaleString()}` : ""}</li>
              ))}
            </ol>
          ) : <p className="text-sm text-slate-400">Route details pending.</p>}
        </section>

        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Transportation price</h3>
          <dl className="space-y-1 text-sm">
            <div className="flex justify-between"><dt className="text-slate-500">Linehaul</dt><dd className="text-slate-800">{dollars(l.customerLinehaulCents)}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">Fuel</dt><dd className="text-slate-800">{dollars(l.customerFuelSurchargeCents)}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">Accessorials</dt><dd className="text-slate-800">{dollars(l.customerAccessorialsCents)}</dd></div>
            <div className="flex justify-between border-t border-slate-200 pt-1 font-medium"><dt className="text-slate-700">Total</dt><dd className="text-slate-900">{dollars(l.customerTotalCents)}</dd></div>
          </dl>
          <p className="mt-2 text-xs text-slate-400">Your quoted transportation price.</p>
        </section>

        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Carrier</h3>
          {carrierName ? <p className="text-sm text-slate-800">{carrierName}</p> : <p className="text-sm text-slate-400">Assigned once your shipment is scheduled.</p>}
          <h3 className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wide text-slate-500">Proof of delivery</h3>
          {podAvailable ? <p className="text-sm text-emerald-700">POD on file.</p> : <p className="text-sm text-slate-400">Available after delivery.</p>}
        </section>

        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Accessorials</h3>
          {l.accessorials.length ? (
            <ul className="space-y-1 text-sm">
              {l.accessorials.map((a) => (
                <li key={a.id} className="flex justify-between text-slate-700"><span>{a.kind.replace(/_/g, " ")}</span><span>{a.approvalStatus === "APPROVED" ? dollars(a.approvedAmountCents) : a.approvalStatus.toLowerCase()}</span></li>
              ))}
            </ul>
          ) : <p className="text-sm text-slate-400">None.</p>}
        </section>
      </div>

      {l.invoices.length > 0 && (
        <section className="mt-4 rounded-lg border border-slate-200 bg-white p-4">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Invoices</h3>
          <ul className="space-y-1 text-sm">
            {l.invoices.map((i) => (
              <li key={i.id} className="flex justify-between text-slate-700"><span>#{i.invoiceNumber} · {i.status}</span><span>{dollars(i.totalCents)}{i.dueDate ? ` · due ${new Date(i.dueDate).toLocaleDateString()}` : ""}</span></li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
