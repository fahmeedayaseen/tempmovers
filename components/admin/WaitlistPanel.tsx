"use client";

import { useCallback, useEffect, useState } from "react";
import { authFetch, NotSignedInError } from "@/lib/client-auth";
import { WAITLIST_INTEREST_LABELS, type WaitlistInterest } from "@/lib/waitlist";

/**
 * Launch waitlist — VASRUE Digital Media, 29 October 2026.
 *
 * Admin screen for the pre-launch waitlist (Carl's waitlist work order §3.4):
 * top-line counts (total / customers / workers), a table of signups, filters
 * by audience and ZIP, and a CSV export of whatever the filters show. Reads
 * GET /api/admin/waitlist; nothing here edits a signup.
 */

type Audience = "CUSTOMER" | "WORKER";

type Row = {
  id: string;
  email: string;
  audience: Audience;
  zipCode: string | null;
  interests: string[];
  hasTruck: boolean | null;
  firstName: string | null;
  source: string | null;
  createdAt: string;
};

type Data = {
  counts: { total: number; customers: number; workers: number };
  filtered: number;
  truncated: boolean;
  rows: Row[];
};

function query(audience: "" | Audience, zip: string, csv = false) {
  const p = new URLSearchParams();
  if (audience) p.set("audience", audience);
  if (zip.trim()) p.set("zip", zip.trim());
  if (csv) p.set("format", "csv");
  const s = p.toString();
  return `/api/admin/waitlist${s ? `?${s}` : ""}`;
}

function sourceLabel(source: string | null) {
  if (!source) return "—";
  try {
    const o = JSON.parse(source) as Record<string, string>;
    return [o.utm_source, o.utm_medium, o.utm_campaign].filter(Boolean).join(" / ") || source;
  } catch {
    return source;
  }
}

export default function WaitlistPanel() {
  const [audience, setAudience] = useState<"" | Audience>("");
  const [zip, setZip] = useState("");
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await authFetch(query(audience, zip));
      if (res.status === 401 || res.status === 403) { setError("Sign in with an admin account to see the waitlist."); return; }
      if (!res.ok) { setError(`Could not load the waitlist (${res.status}).`); return; }
      setData(await res.json());
    } catch (e) {
      setError(e instanceof NotSignedInError ? "Sign in with an admin account to see the waitlist." : "Could not reach the waitlist service.");
    }
  }, [audience, zip]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  async function exportCsv() {
    setExporting(true);
    try {
      const res = await authFetch(query(audience, zip, true));
      if (!res.ok) { setError(`Export failed (${res.status}).`); return; }
      const blob = await res.blob();
      const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? "tempmovers-waitlist.csv";
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(href);
    } catch {
      setError("Could not reach the waitlist service.");
    } finally {
      setExporting(false);
    }
  }

  const tiles = [
    { label: "Total signups", value: data?.counts.total },
    { label: "Customers", value: data?.counts.customers, hint: "I need moving help" },
    { label: "Workers", value: data?.counts.workers, hint: "I want to work" },
  ];

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-900">Launch Waitlist</h1>
        <p className="mt-1 text-sm text-slate-500">
          Everyone who joined from the coming-soon page, for the launch-day email. One email can be on both lists, once each.
        </p>
      </header>

      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-lg border border-slate-200 bg-white px-4 py-3">
            <div className="text-xs uppercase tracking-wide text-slate-500">{t.label}</div>
            <div className="mt-1 text-2xl font-semibold text-slate-900">{t.value ?? "—"}</div>
            {t.hint && <div className="text-xs text-slate-400">{t.hint}</div>}
          </div>
        ))}
      </div>

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="mb-1 block text-xs font-medium text-slate-600">Audience</span>
          <select value={audience} onChange={(e) => setAudience(e.target.value as "" | Audience)} className="rounded-md border border-slate-300 px-3 py-2 text-sm">
            <option value="">Both lists</option>
            <option value="CUSTOMER">Customers</option>
            <option value="WORKER">Workers</option>
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs font-medium text-slate-600">ZIP code</span>
          <input value={zip} onChange={(e) => setZip(e.target.value.replace(/\D/g, "").slice(0, 5))} inputMode="numeric" placeholder="e.g. 46204" className="w-32 rounded-md border border-slate-300 px-3 py-2 text-sm" />
        </label>
        <button onClick={exportCsv} disabled={exporting || !data} className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50">
          {exporting ? "Exporting…" : "Export CSV"}
        </button>
        {data && (
          <span className="text-xs text-slate-500">
            Showing {data.filtered}{data.truncated ? " (newest 5,000)" : ""} of {data.counts.total}
          </span>
        )}
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error} <button onClick={load} className="ml-2 underline">Retry</button>
        </div>
      )}

      {data === null && !error && <p className="text-sm text-slate-400">Loading the waitlist…</p>}
      {data && data.rows.length === 0 && <p className="text-sm text-slate-400">No signups match these filters yet.</p>}

      {data && data.rows.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Email</th>
                <th className="px-4 py-3">Audience</th>
                <th className="px-4 py-3">ZIP</th>
                <th className="px-4 py-3">Interests</th>
                <th className="px-4 py-3">Truck</th>
                <th className="px-4 py-3">Source</th>
                <th className="px-4 py-3">Signed up</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.rows.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-900">{r.email}</div>
                    {r.firstName && <div className="text-xs text-slate-400">{r.firstName}</div>}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${r.audience === "CUSTOMER" ? "bg-sky-100 text-sky-800" : "bg-emerald-100 text-emerald-800"}`}>
                      {r.audience === "CUSTOMER" ? "Customer" : "Worker"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-600">{r.zipCode ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-600">
                    {r.interests.length ? r.interests.map((i) => WAITLIST_INTEREST_LABELS[i as WaitlistInterest] ?? i).join(", ") : "—"}
                  </td>
                  <td className="px-4 py-3 text-slate-600">{r.hasTruck == null ? "—" : r.hasTruck ? "Yes" : "No"}</td>
                  <td className="px-4 py-3 text-xs text-slate-500">{sourceLabel(r.source)}</td>
                  <td className="px-4 py-3 text-xs text-slate-500">{new Date(r.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
