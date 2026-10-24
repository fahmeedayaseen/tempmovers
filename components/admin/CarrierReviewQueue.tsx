"use client";

import { useEffect, useState, useCallback } from "react";
import { listCarriers, type AdminCarrierListRow } from "./carrier-review-api";
import { daysUntil } from "@/components/carrier/carrier-api";

/**
 * Admin carrier review QUEUE. Lists carriers by status, surfaces at-a-glance
 * risk signals (FMCSA outage vs unauthorized, insurance expiry), and links to
 * the detail page for review actions. Admin-only page.
 */

const REVIEW_STATUSES = ["DOCUMENTS_PENDING", "UNDER_REVIEW", "APPROVED", "ACTIVE", "SUSPENDED", "REJECTED", "EXPIRED_DOCUMENTS"] as const;

const STATUS_STYLES: Record<string, string> = {
  APPLICATION_STARTED: "bg-slate-100 text-slate-600", DOCUMENTS_PENDING: "bg-amber-100 text-amber-800",
  UNDER_REVIEW: "bg-sky-100 text-sky-800", APPROVED: "bg-emerald-100 text-emerald-800",
  ACTIVE: "bg-emerald-100 text-emerald-800", TEMPORARILY_INACTIVE: "bg-orange-100 text-orange-800",
  SUSPENDED: "bg-red-100 text-red-800", REJECTED: "bg-red-100 text-red-800", EXPIRED_DOCUMENTS: "bg-red-100 text-red-800",
};

function fmcsaSignal(row: AdminCarrierListRow): { text: string; cls: string } {
  const latest = row.fmcsaChecks[0];
  if (!latest) return { text: "FMCSA: not checked", cls: "text-slate-400" };
  if (latest.checkError) return { text: "FMCSA: provider unavailable", cls: "text-slate-400" }; // outage, not a fault
  if (latest.authorized === false) return { text: "FMCSA: review required", cls: "text-orange-600" };
  if (latest.authorized === true) return { text: "FMCSA: verified", cls: "text-emerald-600" };
  return { text: "FMCSA: pending", cls: "text-amber-600" };
}

function insuranceSignal(row: AdminCarrierListRow): { text: string; cls: string } | null {
  const soonest = row.insurancePolicies
    .map((p) => daysUntil(p.expiresAt))
    .filter((d): d is number => d !== null)
    .sort((a, b) => a - b)[0];
  if (soonest === undefined) return { text: "No insurance on file", cls: "text-slate-400" };
  if (soonest < 0) return { text: "Insurance expired", cls: "text-red-600" };
  if (soonest <= 30) return { text: `Insurance expires in ${soonest}d`, cls: "text-amber-600" };
  return null;
}

export default function CarrierReviewQueue() {
  const [status, setStatus] = useState<string>("DOCUMENTS_PENDING");
  const [rows, setRows] = useState<AdminCarrierListRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (s: string) => {
    setError(null); setRows(null);
    try { setRows(await listCarriers(s)); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not load carriers."); }
  }, []);

  useEffect(() => { load(status); }, [status, load]);

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-900">Carrier review</h1>
        <p className="mt-1 text-sm text-slate-500">Review applications, verify documents and FMCSA, and manage carrier status.</p>
      </header>

      <div className="mb-4 flex flex-wrap gap-2">
        {REVIEW_STATUSES.map((s) => (
          <button key={s} onClick={() => setStatus(s)}
            className={`rounded-full px-3 py-1 text-xs font-medium ${status === s ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}>
            {s.replace(/_/g, " ")}
          </button>
        ))}
      </div>

      {error && <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
      {rows === null && !error && <p className="text-sm text-slate-400">Loading…</p>}
      {rows?.length === 0 && <p className="text-sm text-slate-400">No carriers with status {status.replace(/_/g, " ")}.</p>}

      {rows && rows.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-slate-200">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr><th className="px-4 py-3">Carrier</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Signals</th><th className="px-4 py-3 text-right">Review</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => {
                const fm = fmcsaSignal(row);
                const ins = insuranceSignal(row);
                return (
                  <tr key={row.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-900">{row.legalBusinessName}</div>
                      <div className="text-xs text-slate-400">DOT {row.dotNumber || "—"} · MC {row.mcNumber || "—"}</div>
                    </td>
                    <td className="px-4 py-3"><span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[row.status]}`}>{row.status.replace(/_/g, " ")}</span></td>
                    <td className="px-4 py-3">
                      <div className={`text-xs ${fm.cls}`}>{fm.text}</div>
                      {ins && <div className={`text-xs ${ins.cls}`}>{ins.text}</div>}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <a href={`/admin/carriers/${row.id}`} className="rounded-md border border-slate-300 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100">Open</a>
                    </td>
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
