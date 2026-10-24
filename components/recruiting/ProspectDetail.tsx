"use client";

import { useEffect, useState, useCallback } from "react";
import { getProspect, logActivity, lookupFmcsa, inviteProspect, type Activity, type Prospect } from "./recruiting-api";

/** Prospect detail drawer — contact info, activity timeline (append-only),
 * log-activity, FMCSA qualification lookup, and invite. Recruiter-facing only. */

const FMCSA_DISPLAY: Record<string, { label: string; cls: string }> = {
  AUTHORIZED: { label: "Authorized", cls: "bg-emerald-100 text-emerald-800" },
  NOT_AUTHORIZED: { label: "Not authorized", cls: "bg-orange-100 text-orange-800" },
  OUT_OF_SERVICE: { label: "Out of service", cls: "bg-red-100 text-red-800" },
  NOT_FOUND: { label: "Not found", cls: "bg-slate-100 text-slate-600" },
  PROVIDER_UNAVAILABLE: { label: "Lookup unavailable — try again later", cls: "bg-slate-100 text-slate-500" },
  STALE: { label: "Stale — re-check", cls: "bg-amber-100 text-amber-800" },
};

export default function ProspectDetail({ prospectId, onClose, onChange }: { prospectId: string; onClose: () => void; onChange: () => void }) {
  const [p, setP] = useState<(Prospect & { activities: Activity[] }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [activityType, setActivityType] = useState<"NOTE" | "CALL" | "EMAIL" | "SMS">("NOTE");
  const [fmcsa, setFmcsa] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try { setP(await getProspect(prospectId)); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not load prospect."); }
  }, [prospectId]);
  useEffect(() => { load(); }, [load]);

  async function act(fn: () => Promise<void>) {
    setBusy(true); setError(null);
    try { await fn(); await load(); onChange(); }
    catch (e) { setError(e instanceof Error ? e.message : "Action failed."); }
    finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/40" onClick={onClose}>
      <div className="h-full w-full max-w-md overflow-y-auto bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        {!p ? <p className="text-sm text-slate-400">Loading…</p> : (
          <>
            <div className="flex items-start justify-between">
              <div>
                <h2 className="text-lg font-semibold text-slate-900">{p.companyName}</h2>
                <p className="text-xs text-slate-400">{p.recruitmentStage.replace(/_/g, " ")}</p>
              </div>
              <button onClick={onClose} className="text-slate-400 hover:text-slate-600">✕</button>
            </div>

            {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

            <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
              <dt className="text-xs text-slate-400">Contact</dt><dd className="text-slate-800">{p.contactName || "—"}</dd>
              <dt className="text-xs text-slate-400">Email</dt><dd className="text-slate-800">{p.contactEmail || "—"}</dd>
              <dt className="text-xs text-slate-400">Phone</dt><dd className="text-slate-800">{p.contactPhone || "—"}</dd>
              <dt className="text-xs text-slate-400">DOT / MC</dt><dd className="text-slate-800">{p.dotNumber || "—"} / {p.mcNumber || "—"}</dd>
              <dt className="text-xs text-slate-400">States</dt><dd className="text-slate-800">{p.operatingStates || "—"}</dd>
              <dt className="text-xs text-slate-400">Source</dt><dd className="text-slate-800">{p.leadSource.replace(/_/g, " ")}{p.referralSource ? ` (${p.referralSource})` : ""}</dd>
            </dl>

            <div className="mt-4 flex flex-wrap gap-2">
              <button className="rounded-md border border-slate-300 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50" disabled={busy}
                onClick={() => act(async () => { const r = await lookupFmcsa(p.id); setFmcsa(r.state); })}>FMCSA lookup</button>
              <button className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50" disabled={busy}
                onClick={() => act(() => inviteProspect(p.id))}>Send application invite</button>
              {p.convertedCarrierId && <a href={`/admin/carriers/${p.convertedCarrierId}`} className="rounded-md border border-emerald-300 px-3 py-1.5 text-xs text-emerald-700">View carrier →</a>}
            </div>
            {fmcsa && <div className="mt-2"><span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${FMCSA_DISPLAY[fmcsa]?.cls}`}>{FMCSA_DISPLAY[fmcsa]?.label ?? fmcsa}</span></div>}

            {/* Log activity */}
            <div className="mt-6 rounded-md border border-slate-200 p-3">
              <p className="mb-2 text-sm font-medium text-slate-700">Log contact</p>
              <div className="flex gap-2">
                <select className="rounded-md border border-slate-300 px-2 py-1.5 text-sm" value={activityType} onChange={(e) => setActivityType(e.target.value as typeof activityType)}>
                  <option value="NOTE">Note</option><option value="CALL">Call</option><option value="EMAIL">Email</option><option value="SMS">SMS</option>
                </select>
                <input className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm" placeholder="What happened?" value={note} onChange={(e) => setNote(e.target.value)} />
              </div>
              <button className="mt-2 rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50" disabled={busy || !note.trim()}
                onClick={() => act(async () => { await logActivity(p.id, { activityType, notes: note }); setNote(""); })}>Log</button>
            </div>

            {/* Timeline */}
            <div className="mt-6">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Activity timeline</p>
              {p.activities.length ? (
                <ul className="space-y-2">
                  {p.activities.map((a) => (
                    <li key={a.id} className="border-l-2 border-slate-200 pl-3 text-sm">
                      <span className="text-xs font-medium text-slate-600">{a.activityType.replace(/_/g, " ")}</span>
                      <span className="text-xs text-slate-400"> · {new Date(a.occurredAt).toLocaleString()}</span>
                      {a.notes && <p className="text-slate-700">{a.notes}</p>}
                    </li>
                  ))}
                </ul>
              ) : <p className="text-sm text-slate-400">No activity yet.</p>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
