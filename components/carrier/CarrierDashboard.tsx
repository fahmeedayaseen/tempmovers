"use client";

import { useEffect, useState, useCallback } from "react";
import {
  getCarrier, getEligibility, getFmcsaStatus, getFactoring, listInsurance,
  documentState, type CarrierRecord, type CarrierEligibility, type FmcsaStatus,
  type FactoringProfile, type PaymentAssignment, type InsurancePolicy,
} from "./carrier-api";
import { InsuranceBanner, DocStateBadge } from "./CarrierWizardSteps";

/**
 * Carrier dashboard — reflects REAL backend status. It never computes
 * eligibility itself; it renders the server's eligibility blockers (with their
 * carrier-safe corrective actions), the server's FMCSA state, and server dates
 * for insurance warnings.
 *
 * Privacy: this screen only reads carrier-scoped endpoints. It never requests
 * or shows internal risk notes, brokerage margins, other carriers' data, admin
 * comments, fraud scoring, or internal audit records — those have no
 * carrier-facing route, and nothing here asks for them.
 */

const STATUS_STYLES: Record<string, string> = {
  APPLICATION_STARTED: "bg-slate-100 text-slate-700", DOCUMENTS_PENDING: "bg-amber-100 text-amber-800",
  UNDER_REVIEW: "bg-sky-100 text-sky-800", APPROVED: "bg-emerald-100 text-emerald-800",
  ACTIVE: "bg-emerald-100 text-emerald-800", TEMPORARILY_INACTIVE: "bg-orange-100 text-orange-800",
  SUSPENDED: "bg-red-100 text-red-800", REJECTED: "bg-red-100 text-red-800", EXPIRED_DOCUMENTS: "bg-red-100 text-red-800",
};

const FMCSA_DISPLAY: Record<string, { label: string; cls: string }> = {
  NOT_CHECKED: { label: "Not checked yet", cls: "bg-slate-100 text-slate-600" },
  PENDING: { label: "Verification pending", cls: "bg-amber-100 text-amber-800" },
  VERIFIED: { label: "Verified", cls: "bg-emerald-100 text-emerald-800" },
  MISMATCH: { label: "Details mismatch", cls: "bg-orange-100 text-orange-800" },
  STALE: { label: "Re-verification needed", cls: "bg-amber-100 text-amber-800" },
  REVIEW_REQUIRED: { label: "Review required", cls: "bg-orange-100 text-orange-800" },
  PROVIDER_UNAVAILABLE: { label: "Verification service temporarily unavailable", cls: "bg-slate-100 text-slate-600" },
};

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h3>
      {children}
    </section>
  );
}

export default function CarrierDashboard() {
  const [carrier, setCarrier] = useState<CarrierRecord | null>(null);
  const [eligibility, setEligibility] = useState<CarrierEligibility | null>(null);
  const [fmcsa, setFmcsa] = useState<FmcsaStatus | null>(null);
  const [factoring, setFactoring] = useState<{ profile: FactoringProfile; activeAssignment: PaymentAssignment } | null>(null);
  const [insurance, setInsurance] = useState<InsurancePolicy[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [noCarrier, setNoCarrier] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const c = await getCarrier();
      if (!c) { setNoCarrier(true); return; }
      setCarrier(c);
      // Best-effort side loads — a failure in one shouldn't blank the page.
      const [elig, fm, fac, ins] = await Promise.allSettled([getEligibility(), getFmcsaStatus(), getFactoring(), listInsurance()]);
      if (elig.status === "fulfilled") setEligibility(elig.value);
      if (fm.status === "fulfilled") setFmcsa(fm.value);
      if (fac.status === "fulfilled") setFactoring(fac.value);
      if (ins.status === "fulfilled") setInsurance(ins.value);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load your dashboard.");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (noCarrier) return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <p className="text-sm text-slate-500">You haven't started a carrier application yet.</p>
      <a href="/carrier/application" className="mt-3 inline-block rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white">Start application</a>
    </div>
  );
  if (error) return <div className="mx-auto max-w-5xl px-6 py-10"><div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div></div>;
  if (!carrier) return <div className="mx-auto max-w-5xl px-6 py-10 text-sm text-slate-400">Loading your dashboard…</div>;

  const currentDocs = carrier.documents.filter((d) => documentState(d) !== "SUPERSEDED");
  const supersededDocs = carrier.documents.filter((d) => documentState(d) === "SUPERSEDED");

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">{carrier.legalBusinessName || "Your carrier account"}</h1>
          <p className="mt-1 text-sm text-slate-500">DOT {carrier.dotNumber || "—"} · MC {carrier.mcNumber || "—"}</p>
        </div>
        <span className={`rounded-full px-3 py-1 text-sm font-medium ${STATUS_STYLES[carrier.status] ?? "bg-slate-100 text-slate-600"}`}>
          {carrier.status.replace(/_/g, " ")}
        </span>
      </header>

      {/* Required actions from eligibility blockers */}
      {eligibility && !eligibility.eligible && eligibility.blockers.length > 0 && (
        <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-4">
          <h2 className="text-sm font-semibold text-amber-900">Required actions</h2>
          <ul className="mt-2 space-y-2">
            {eligibility.blockers.map((b) => (
              <li key={b.code} className="text-sm text-amber-800">
                <span className="font-medium">{b.message}</span> <span className="text-amber-700">— {b.action}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {eligibility?.eligible && (
        <div className="mb-6 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">You meet all current requirements.</div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="FMCSA verification">
          {fmcsa ? (
            <div>
              <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${FMCSA_DISPLAY[fmcsa.state]?.cls}`}>{FMCSA_DISPLAY[fmcsa.state]?.label ?? fmcsa.state}</span>
              {fmcsa.detail && <p className="mt-2 text-xs text-slate-500">{fmcsa.detail}</p>}
            </div>
          ) : <p className="text-sm text-slate-400">Not available.</p>}
        </Card>

        <Card title="Insurance">
          {insurance.length ? (
            <ul className="space-y-1 text-sm">
              {insurance.map((p) => (
                <li key={p.id} className="text-slate-700">
                  {p.type.replace(/_/g, " ")}<InsuranceBanner expiresAt={p.expiresAt} />
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-slate-400">No policies on file.</p>}
        </Card>

        <Card title="Documents">
          <ul className="space-y-1 text-sm">
            {currentDocs.length ? currentDocs.map((d) => (
              <li key={d.id} className="text-slate-700">
                {d.type.replace(/_/g, " ")}<DocStateBadge state={documentState(d)} />
                {documentState(d) === "REJECTED" && d.rejectionReason && <span className="ml-1 text-xs text-red-600">({d.rejectionReason})</span>}
              </li>
            )) : <li className="text-slate-400">No documents uploaded.</li>}
          </ul>
          {supersededDocs.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-slate-400">Document history ({supersededDocs.length} superseded)</summary>
              <ul className="mt-1 space-y-1 text-xs text-slate-400">
                {supersededDocs.map((d) => <li key={d.id}>{d.type.replace(/_/g, " ")} — superseded</li>)}
              </ul>
            </details>
          )}
        </Card>

        <Card title="Factoring & payment routing">
          {factoring?.profile?.usesFactoring ? (
            <div className="space-y-1 text-sm text-slate-700">
              <p>{factoring.profile.factoringCompanyName || "Factoring company on file"}</p>
              <p className="text-xs text-slate-500">Verification: {factoring.profile.verificationStatus.replace(/_/g, " ")}</p>
              {factoring.activeAssignment ? (
                <p className="text-xs text-slate-500">Payments routed to {factoring.activeAssignment.remitToName} (locked — changes go to admin review).</p>
              ) : <p className="text-xs text-slate-400">No active payment assignment yet.</p>}
            </div>
          ) : <p className="text-sm text-slate-400">Not using factoring.</p>}
        </Card>

        <Card title="Equipment">
          {carrier.equipment.length ? (
            <ul className="space-y-1 text-sm text-slate-700">{carrier.equipment.map((e) => <li key={e.id}>{e.equipmentType}{e.hasLiftgate ? " · liftgate" : ""}</li>)}</ul>
          ) : <p className="text-sm text-slate-400">None listed.</p>}
        </Card>

        <Card title="Preferred lanes">
          {carrier.lanes.length ? (
            <ul className="space-y-1 text-sm text-slate-700">{carrier.lanes.map((l) => <li key={l.id}>{[l.originMetro, l.originState].filter(Boolean).join(", ") || "Any"} → {[l.destinationMetro, l.destinationState].filter(Boolean).join(", ") || "Any"}</li>)}</ul>
          ) : <p className="text-sm text-slate-400">None listed.</p>}
        </Card>

        <Card title="Agreements">
          {carrier.agreements.length ? (
            <ul className="space-y-1 text-sm text-slate-700">{carrier.agreements.map((a) => <li key={a.id}>{a.agreementType} {a.active ? "· active" : "· inactive"}</li>)}</ul>
          ) : <p className="text-sm text-slate-400">None acknowledged.</p>}
        </Card>
      </div>

      <div className="mt-6">
        <a href="/carrier/application" className="text-sm text-slate-600 underline">Edit application / upload documents</a>
      </div>
    </div>
  );
}
