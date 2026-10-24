"use client";

import { useEffect, useState } from "react";
import { getDashboard, STAGES, type Dashboard } from "./recruiting-api";

/** Recruiting dashboard — progress toward 200 active carriers, pipeline
 * distribution, and follow-up load. All real DB aggregates. */
export default function RecruitingDashboard() {
  const [d, setD] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { (async () => {
    try { setD(await getDashboard()); } catch (e) { setError(e instanceof Error ? e.message : "Could not load dashboard."); }
  })(); }, []);

  if (error) return <div className="mx-auto max-w-4xl px-6 py-10"><div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div></div>;
  if (!d) return <div className="mx-auto max-w-4xl px-6 py-10 text-sm text-slate-400">Loading…</div>;

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-900">Recruiting dashboard</h1>
        <a href="/recruiting" className="rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50">Pipeline</a>
      </header>

      {/* 200-carrier progress */}
      <section className="mb-6 rounded-lg border border-slate-200 bg-white p-5">
        <div className="flex items-end justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Active carriers toward goal</p>
            <p className="mt-1 text-3xl font-semibold text-slate-900">{d.activeCarriers} <span className="text-lg font-normal text-slate-400">/ {d.goal}</span></p>
          </div>
          <span className="text-sm font-medium text-slate-600">{d.progressPercent}%</span>
        </div>
        <div className="mt-3 h-3 w-full rounded-full bg-slate-100">
          <div className="h-3 rounded-full bg-emerald-500 transition-all" style={{ width: `${d.progressPercent}%` }} />
        </div>
        <p className="mt-2 text-xs text-slate-400">{d.convertedProspects} prospects converted to carrier accounts so far.</p>
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Pipeline by stage</h3>
          <ul className="space-y-1 text-sm">
            {STAGES.filter((s) => (d.pipeline[s] ?? 0) > 0).map((s) => (
              <li key={s} className="flex justify-between text-slate-700"><span>{s.replace(/_/g, " ")}</span><span className="font-medium">{d.pipeline[s]}</span></li>
            ))}
            {Object.keys(d.pipeline).length === 0 && <li className="text-slate-400">No prospects yet.</li>}
          </ul>
        </section>

        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Follow-up load</h3>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between"><dt className="text-slate-500">Overdue follow-ups</dt><dd className={`font-medium ${d.followUpsOverdue > 0 ? "text-red-600" : "text-slate-800"}`}>{d.followUpsOverdue}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">Tasks due this week</dt><dd className="font-medium text-slate-800">{d.tasksDueThisWeek}</dd></div>
          </dl>
        </section>
      </div>
    </div>
  );
}
