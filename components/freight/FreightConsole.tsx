"use client";

import { useEffect, useState, useCallback } from "react";
import { getFreightDashboard, listLoads, dollars, type FreightDashboard, type LoadListRow, type LoadStatus } from "./freight-api";

/**
 * Freight Operations Console — dashboard + load list. Admin-only (recruiters
 * excluded). When brokerage is dormant, a prominent banner explains that
 * production freight actions are disabled; the console stays usable for
 * config/test data.
 */

const ALL_STATUSES: LoadStatus[] = ["DRAFT", "QUOTE_REQUESTED", "QUOTED", "BOOKED", "AVAILABLE", "OFFERED", "ACCEPTED", "DISPATCHED", "AT_PICKUP", "LOADED", "IN_TRANSIT", "AT_DELIVERY", "DELIVERED", "POD_PENDING", "COMPLETED", "INVOICED", "PAID", "CANCELED", "EXCEPTION"];

export function DormantBanner() {
  return (
    <div className="mb-6 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3">
      <p className="text-sm font-semibold text-amber-900">Freight brokerage is not active.</p>
      <p className="mt-1 text-xs text-amber-800">
        Production load posting, carrier acceptance, quoting, rate confirmations, invoicing, and settlement actions remain disabled.
        The console is available for configuration and test data only.
      </p>
    </div>
  );
}

export default function FreightConsole() {
  const [dash, setDash] = useState<FreightDashboard | null>(null);
  const [loads, setLoads] = useState<LoadListRow[] | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const loadDash = useCallback(async () => {
    try { setDash(await getFreightDashboard()); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not load dashboard."); }
  }, []);
  const loadList = useCallback(async (status: string) => {
    try { const r = await listLoads(status ? { status } : {}); setLoads(r.loads); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not load loads."); }
  }, []);

  useEffect(() => { loadDash(); }, [loadDash]);
  useEffect(() => { loadList(statusFilter); }, [statusFilter, loadList]);

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-900">Freight operations</h1>
        <p className="mt-1 text-sm text-slate-500">Manage loads, offers, dispatch, documents, and settlements.</p>
      </header>

      {dash && !dash.brokerageActive && <DormantBanner />}
      {error && <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      {/* Attention + financials */}
      {dash && (
        <div className="mb-6 grid gap-4 md:grid-cols-2">
          <section className="rounded-lg border border-slate-200 bg-white p-4">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Needs attention</h3>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <Stat label="Offers awaiting response" value={dash.attention.offersAwaitingResponse} />
              <Stat label="Missing rate confirmation" value={dash.attention.loadsMissingRateConfirmation} />
              <Stat label="PODs awaiting approval" value={dash.attention.podsAwaitingApproval} />
              <Stat label="Accessorials to review" value={dash.attention.accessorialsAwaitingReview} />
              <Stat label="In exception" value={dash.attention.loadsInException} danger />
            </dl>
          </section>
          <section className="rounded-lg border border-slate-200 bg-white p-4">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Financial summary</h3>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between"><dt className="text-slate-500">Customer total</dt><dd className="font-medium text-slate-900">{dollars(dash.financials.customerTotalCents)}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Gross margin</dt><dd className="font-medium text-slate-900">{dollars(dash.financials.grossMarginCents)}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Platform revenue</dt><dd className="font-medium text-slate-900">{dollars(dash.financials.platformRevenueCents)}</dd></div>
            </dl>
            <p className="mt-2 text-xs text-slate-400">Server-calculated from integer cents.</p>
          </section>
        </div>
      )}

      {/* Status counts */}
      {dash && (
        <div className="mb-6 flex flex-wrap gap-2">
          <button onClick={() => setStatusFilter("")} className={`rounded-full px-3 py-1 text-xs font-medium ${statusFilter === "" ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600"}`}>All</button>
          {ALL_STATUSES.filter((s) => (dash.statusCounts[s] ?? 0) > 0).map((s) => (
            <button key={s} onClick={() => setStatusFilter(s)} className={`rounded-full px-3 py-1 text-xs font-medium ${statusFilter === s ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}>
              {s.replace(/_/g, " ")} ({dash.statusCounts[s]})
            </button>
          ))}
        </div>
      )}

      {/* Load list */}
      {loads === null ? <p className="text-sm text-slate-400">Loading loads…</p> : loads.length === 0 ? <p className="text-sm text-slate-400">No loads{statusFilter ? ` with status ${statusFilter.replace(/_/g, " ")}` : ""}.</p> : (
        <div className="overflow-hidden rounded-lg border border-slate-200">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr><th className="px-4 py-3">Load</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Customer</th><th className="px-4 py-3">Margin</th><th className="px-4 py-3 text-right">Open</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loads.map((l) => (
                <tr key={l.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-900">{l.commodity || "Load"} <span className="text-xs text-slate-400">{l.equipmentType || ""}</span></div>
                    <div className="text-xs text-slate-400">{l.id.slice(0, 8)} · {l._count.offers} offers · {l._count.rateConfirmations} rate cons</div>
                  </td>
                  <td className="px-4 py-3"><span className="inline-block rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700">{l.status.replace(/_/g, " ")}</span></td>
                  <td className="px-4 py-3 text-slate-700">{dollars(l.customerTotalCents)}</td>
                  <td className="px-4 py-3 text-slate-700">{dollars(l.grossMarginCents)}</td>
                  <td className="px-4 py-3 text-right"><a href={`/admin/freight/${l.id}`} className="rounded-md border border-slate-300 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100">Open</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, danger }: { label: string; value: number; danger?: boolean }) {
  return (
    <div className="flex flex-col">
      <dt className="text-xs text-slate-400">{label}</dt>
      <dd className={`text-lg font-semibold ${danger && value > 0 ? "text-red-600" : "text-slate-900"}`}>{value}</dd>
    </div>
  );
}
