"use client";

import { useEffect, useState, useCallback } from "react";
import {
  getCarrierDetail, transitionCarrier, reviewDocument, refreshFmcsa, addNote, reviewFactoring, getAdminEligibility,
  type AdminCarrierDetail,
} from "./carrier-review-api";
import { daysUntil } from "@/components/carrier/carrier-api";

/**
 * Admin carrier review DETAIL — the reviewer's workspace.
 *
 * Approval and activation are SEPARATE actions, reflecting the backend:
 *   APPROVED = compliance review passed.
 *   ACTIVE   = currently eligible to receive load opportunities (backend
 *              additionally requires valid insurance → 428 otherwise).
 */

const btn = "rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-50";
const btnPrimary = `${btn} bg-slate-900 text-white`;
const btnGood = `${btn} bg-emerald-600 text-white`;
const btnWarn = `${btn} bg-amber-600 text-white`;
const btnDanger = `${btn} bg-red-600 text-white`;
const btnGhost = `${btn} border border-slate-300 text-slate-700 hover:bg-slate-50`;

function Card({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

export default function CarrierReviewDetail({ carrierId }: { carrierId: string }) {
  const [data, setData] = useState<AdminCarrierDetail | null>(null);
  const [eligibility, setEligibility] = useState<{ eligible: boolean; blockers: { code: string; message: string }[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    setError(null);
    try {
      const d = await getCarrierDetail(carrierId);
      setData(d);
      try { setEligibility(await getAdminEligibility(carrierId)); } catch { setEligibility(null); }
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load carrier."); }
  }, [carrierId]);

  useEffect(() => { load(); }, [load]);

  async function act(fn: () => Promise<void>) {
    setBusy(true); setError(null);
    try { await fn(); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "Action failed."); }
    finally { setBusy(false); }
  }

  if (error && !data) return <div className="mx-auto max-w-5xl px-6 py-10"><div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div></div>;
  if (!data) return <div className="mx-auto max-w-5xl px-6 py-10 text-sm text-slate-400">Loading…</div>;

  const c = data.carrier;
  const latestFmcsa = c.fmcsaChecks[0];
  const currentDocs = c.documents.filter((d) => !d.supersededById && !d.supersededAt);

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <a href="/admin/carriers" className="text-xs text-slate-500 underline">← Back to queue</a>
      <header className="mb-6 mt-2 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">{c.legalBusinessName}</h1>
          <p className="mt-1 text-sm text-slate-500">DOT {c.dotNumber || "—"} · MC {c.mcNumber || "—"} · {c.status.replace(/_/g, " ")}</p>
        </div>
      </header>

      {error && <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      {/* Status actions — APPROVE and ACTIVATE are separate */}
      <div className="mb-6 flex flex-wrap gap-2 rounded-lg border border-slate-200 bg-slate-50 p-4">
        <span className="mr-2 self-center text-xs font-medium text-slate-500">Actions:</span>
        <button className={btnGood} disabled={busy} onClick={() => act(() => transitionCarrier(c.id, "APPROVED", "Compliance review passed"))}>Approve (compliance)</button>
        <button className={btnPrimary} disabled={busy} onClick={() => act(() => transitionCarrier(c.id, "ACTIVE", "Activated for load opportunities"))}>Activate</button>
        <button className={btnWarn} disabled={busy} onClick={() => act(() => transitionCarrier(c.id, "TEMPORARILY_INACTIVE", "Temporarily paused"))}>Pause</button>
        <button className={btnDanger} disabled={busy} onClick={() => { const r = prompt("Reason for suspension?"); if (r) act(() => transitionCarrier(c.id, "SUSPENDED", r)); }}>Suspend</button>
        <button className={btnGhost} disabled={busy} onClick={() => act(() => transitionCarrier(c.id, "UNDER_REVIEW", "Moved to review"))}>Mark under review</button>
      </div>
      <p className="-mt-4 mb-6 text-xs text-slate-400">Approve records that compliance passed. Activate makes the carrier eligible for load opportunities and requires valid insurance — the system will block activation otherwise.</p>

      {/* Eligibility blockers */}
      {eligibility && !eligibility.eligible && eligibility.blockers.length > 0 && (
        <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-4">
          <h2 className="text-sm font-semibold text-amber-900">Blocked by</h2>
          <ul className="mt-2 list-disc pl-5 text-sm text-amber-800">
            {eligibility.blockers.map((b) => <li key={b.code}>{b.message}</li>)}
          </ul>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Company & authority">
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
            <dt className="text-xs text-slate-400">DBA</dt><dd className="text-slate-800">{c.dbaName || "—"}</dd>
            <dt className="text-xs text-slate-400">EIN</dt><dd className="text-slate-800">{c.ein || "—"}</dd>
            <dt className="text-xs text-slate-400">Home terminal</dt><dd className="text-slate-800">{c.homeTerminal || "—"}</dd>
            <dt className="text-xs text-slate-400">Radius</dt><dd className="text-slate-800">{c.operatingRadiusMiles ?? "—"} mi</dd>
            <dt className="text-xs text-slate-400">Trucks</dt><dd className="text-slate-800">{c.numberOfTrucks ?? "—"}</dd>
          </dl>
        </Card>

        <Card title="FMCSA verification" action={<button className={btnGhost} disabled={busy} onClick={() => act(() => refreshFmcsa(c.id))}>Re-check</button>}>
          {latestFmcsa ? (
            <div className="text-sm">
              {latestFmcsa.checkError ? (
                <p className="text-slate-500">Provider unavailable ({latestFmcsa.checkError}). Not a carrier fault — re-check when the provider is back.</p>
              ) : (
                <p className="text-slate-800">Authorized: {latestFmcsa.authorized === null ? "pending" : latestFmcsa.authorized ? "yes" : "no"} · {latestFmcsa.operatingStatus ?? "—"}</p>
              )}
              <p className="mt-1 text-xs text-slate-400">Checked {new Date(latestFmcsa.checkedAt).toLocaleString()}</p>
            </div>
          ) : <p className="text-sm text-slate-400">Not checked yet.</p>}
        </Card>

        <Card title="Insurance">
          {c.insurancePolicies.length ? (
            <ul className="space-y-1 text-sm">
              {c.insurancePolicies.map((p) => {
                const d = daysUntil(p.expiresAt);
                return <li key={p.id} className="text-slate-700">{p.type.replace(/_/g, " ")} · {p.insurerName || "insurer TBD"} · {p.expiresAt ? new Date(p.expiresAt).toLocaleDateString() : "no expiry"}{d !== null && d < 30 && <span className={`ml-1 text-xs ${d < 0 ? "text-red-600" : "text-amber-600"}`}>({d < 0 ? "expired" : `${d}d`})</span>}</li>;
              })}
            </ul>
          ) : <p className="text-sm text-slate-400">None on file.</p>}
        </Card>

        <Card title="Factoring & payment routing">
          {data.factoringProfile?.usesFactoring ? (
            <div className="text-sm text-slate-700">
              <p>{data.factoringProfile.factoringCompanyName || "Company on file"} · {data.factoringProfile.verificationStatus.replace(/_/g, " ")}</p>
              {data.activeAssignment && <p className="mt-1 text-xs text-slate-500">Active NOA → {data.activeAssignment.remitToName}</p>}
              <div className="mt-2 flex gap-2">
                <button className={btnGood} disabled={busy} onClick={() => act(() => reviewFactoring(c.id, "VERIFIED"))}>Verify NOA</button>
                <button className={btnDanger} disabled={busy} onClick={() => { const r = prompt("Reason?"); act(() => reviewFactoring(c.id, "REJECTED", r || undefined)); }}>Reject</button>
              </div>
            </div>
          ) : <p className="text-sm text-slate-400">Not using factoring.</p>}
        </Card>
      </div>

      {/* Documents */}
      <div className="mt-4">
        <Card title="Documents">
          {currentDocs.length ? (
            <ul className="divide-y divide-slate-100">
              {currentDocs.map((d) => (
                <li key={d.id} className="flex items-center justify-between py-2 text-sm">
                  <div>
                    <span className="text-slate-800">{d.type.replace(/_/g, " ")}</span>
                    <span className="ml-2 text-xs text-slate-400">{d.verified ? "approved" : d.rejectionReason ? `rejected: ${d.rejectionReason}` : "pending review"}</span>
                  </div>
                  <div className="flex gap-2">
                    <button className={btnGood} disabled={busy || d.verified} onClick={() => act(() => reviewDocument(c.id, d.id, "APPROVE"))}>Approve</button>
                    <button className={btnDanger} disabled={busy} onClick={() => { const r = prompt("Rejection reason?"); if (r) act(() => reviewDocument(c.id, d.id, "REJECT", r)); }}>Reject</button>
                  </div>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-slate-400">No documents uploaded.</p>}
        </Card>
      </div>

      {/* Status history + internal notes */}
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <Card title="Status history">
          {c.statusEvents.length ? (
            <ul className="space-y-1 text-xs text-slate-500">
              {c.statusEvents.map((e) => (
                <li key={e.id}>{new Date(e.createdAt).toLocaleDateString()} — {e.fromStatus ? `${e.fromStatus.replace(/_/g, " ")} → ` : ""}{e.toStatus.replace(/_/g, " ")}{e.reason ? ` (${e.reason})` : ""}</li>
              ))}
            </ul>
          ) : <p className="text-sm text-slate-400">No history yet.</p>}
        </Card>

        <Card title="Internal notes (admin-only)">
          <div className="mb-2 flex gap-2">
            <input className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm" placeholder="Add an internal note…" value={note} onChange={(e) => setNote(e.target.value)} />
            <button className={btnPrimary} disabled={busy || !note.trim()} onClick={() => act(async () => { await addNote(c.id, note); setNote(""); })}>Add</button>
          </div>
          {c.notes.length ? (
            <ul className="space-y-1 text-xs text-slate-600">
              {c.notes.map((n) => <li key={n.id}><span className="text-slate-400">{new Date(n.createdAt).toLocaleDateString()}:</span> {n.body}</li>)}
            </ul>
          ) : <p className="text-sm text-slate-400">No notes.</p>}
        </Card>
      </div>
    </div>
  );
}
