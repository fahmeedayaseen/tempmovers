"use client";

import { useEffect, useState, useCallback } from "react";
import { listProspects, updateProspect, createProspect, STAGES, LEAD_SOURCES, type Prospect, type Stage } from "./recruiting-api";
import ProspectDetail from "./ProspectDetail";

/**
 * Recruiting pipeline — Kanban board of prospects by stage. Moving a card to a
 * new column PATCHes recruitmentStage (which logs a STAGE_CHANGE activity
 * server-side). Recruiter-facing: shows only prospect/pipeline data, never
 * finance or compliance.
 */

// The active recruiting columns (terminal/disqualified stages are shown in a
// separate collapsed area to keep the board focused on live pipeline).
const BOARD_STAGES: Stage[] = ["NEW_LEAD", "CONTACT_ATTEMPTED", "CONTACTED", "INTERESTED", "APPLICATION_SENT", "APPLICATION_STARTED", "UNDER_REVIEW", "APPROVED", "ACTIVE"];
const STAGE_LABEL: Record<string, string> = Object.fromEntries(STAGES.map((s) => [s, s.replace(/_/g, " ")]));

export default function RecruitingPipeline() {
  const [prospects, setProspects] = useState<Prospect[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try { setProspects(await listProspects()); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not load prospects."); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function move(p: Prospect, stage: Stage) {
    // Optimistic update, then persist.
    setProspects((prev) => prev?.map((x) => (x.id === p.id ? { ...x, recruitmentStage: stage } : x)) ?? null);
    try { await updateProspect({ id: p.id, recruitmentStage: stage }); }
    catch (e) { setError(e instanceof Error ? e.message : "Move failed."); load(); }
  }

  const byStage = (s: Stage) => prospects?.filter((p) => p.recruitmentStage === s) ?? [];

  return (
    <div className="px-6 py-8">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Recruiting pipeline</h1>
          <p className="mt-1 text-sm text-slate-500">Move prospects through the pipeline toward onboarding. Building toward 200 active carriers.</p>
        </div>
        <div className="flex gap-2">
          <a href="/recruiting/dashboard" className="rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50">Dashboard</a>
          <button onClick={() => setShowAdd(true)} className="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white">Add prospect</button>
        </div>
      </header>

      {error && <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
      {prospects === null && !error && <p className="text-sm text-slate-400">Loading…</p>}

      {prospects && (
        <div className="flex gap-4 overflow-x-auto pb-4">
          {BOARD_STAGES.map((stage) => {
            const cards = byStage(stage);
            return (
              <div key={stage} className="w-64 flex-shrink-0">
                <div className="mb-2 flex items-center justify-between px-1">
                  <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">{STAGE_LABEL[stage]}</span>
                  <span className="text-xs text-slate-400">{cards.length}</span>
                </div>
                <div className="space-y-2 rounded-lg bg-slate-50 p-2">
                  {cards.map((p) => (
                    <div key={p.id} className="rounded-md border border-slate-200 bg-white p-3 shadow-sm">
                      <button onClick={() => setSelected(p.id)} className="text-left text-sm font-medium text-slate-900 hover:underline">{p.companyName}</button>
                      <p className="text-xs text-slate-400">DOT {p.dotNumber || "—"} · {p.operatingStates || "states TBD"}</p>
                      {p.nextFollowUpAt && new Date(p.nextFollowUpAt) < new Date() && <p className="mt-1 text-xs text-red-600">Follow-up overdue</p>}
                      <select value={p.recruitmentStage} onChange={(e) => move(p, e.target.value as Stage)}
                        className="mt-2 w-full rounded border border-slate-200 px-1 py-0.5 text-xs text-slate-600">
                        {STAGES.map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}
                      </select>
                    </div>
                  ))}
                  {cards.length === 0 && <p className="px-1 py-4 text-center text-xs text-slate-300">Empty</p>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {selected && <ProspectDetail prospectId={selected} onClose={() => setSelected(null)} onChange={load} />}
      {showAdd && <AddProspect onClose={() => setShowAdd(false)} onAdded={() => { setShowAdd(false); load(); }} />}
    </div>
  );
}

function AddProspect({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [form, setForm] = useState({ companyName: "", contactName: "", contactEmail: "", dotNumber: "", mcNumber: "", operatingStates: "", leadSource: "OTHER" as const });
  const [dupe, setDupe] = useState<{ id: string; companyName: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const input = "w-full rounded-md border border-slate-300 px-3 py-2 text-sm";

  async function save() {
    if (!form.companyName.trim()) { setError("Company name is required."); return; }
    setSaving(true); setError(null); setDupe(null);
    try {
      const { duplicateWarning } = await createProspect({ ...form });
      if (duplicateWarning) setDupe(duplicateWarning);
      onAdded();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not add."); }
    finally { setSaving(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold text-slate-900">Add prospect</h2>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        {dupe && <p className="mt-2 rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">Heads up: a prospect with this DOT/MC already exists ({dupe.companyName}).</p>}
        <div className="mt-4 space-y-3">
          <input className={input} placeholder="Company name *" value={form.companyName} onChange={(e) => setForm({ ...form, companyName: e.target.value })} />
          <div className="grid grid-cols-2 gap-3">
            <input className={input} placeholder="Contact name" value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })} />
            <input className={input} placeholder="Contact email" value={form.contactEmail} onChange={(e) => setForm({ ...form, contactEmail: e.target.value })} />
            <input className={input} placeholder="DOT #" value={form.dotNumber} onChange={(e) => setForm({ ...form, dotNumber: e.target.value })} />
            <input className={input} placeholder="MC #" value={form.mcNumber} onChange={(e) => setForm({ ...form, mcNumber: e.target.value })} />
          </div>
          <input className={input} placeholder="Operating states (e.g. IN, IL, OH)" value={form.operatingStates} onChange={(e) => setForm({ ...form, operatingStates: e.target.value })} />
          <select className={input} value={form.leadSource} onChange={(e) => setForm({ ...form, leadSource: e.target.value as typeof form.leadSource })}>
            {LEAD_SOURCES.map((s) => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}
          </select>
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-md border border-slate-300 px-4 py-2 text-sm text-slate-700">Cancel</button>
          <button onClick={save} disabled={saving} className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{saving ? "Saving…" : "Add"}</button>
        </div>
      </div>
    </div>
  );
}
