"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import {
  getCarrier, saveApplication, submitApplication, type CarrierApplicationInput, type CarrierRecord,
} from "./carrier-api";
import { InsuranceStep, EquipmentStep, LanesStep, DocumentsStep, FactoringStep } from "./CarrierWizardSteps";

/**
 * Carrier application wizard — 8 steps, save-and-resume, progress %, step-level
 * validation, unsaved-change warning, server error display, final submit.
 *
 * Persistence model: the application POST is an upsert of the scalar carrier
 * fields, so "save and resume" works by saving accumulated fields. Insurance,
 * equipment, lanes, documents, and factoring documents persist through their
 * own endpoints (handled inside their step components), so they save
 * immediately and don't depend on the wizard's scalar save.
 */

const STEPS = [
  "Company information", "DOT/MC & authority", "Insurance", "W-9 & agreements",
  "Equipment & fleet", "Preferred lanes", "Factoring & payment", "Review & submit",
] as const;

type ScalarForm = CarrierApplicationInput;

export default function CarrierApplicationWizard() {
  const [carrier, setCarrier] = useState<CarrierRecord | null>(null);
  const [form, setForm] = useState<ScalarForm>({ legalBusinessName: "" });
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stepError, setStepError] = useState<string | null>(null);
  const savedFormRef = useRef<string>("");

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const c = await getCarrier();
      if (c) {
        setCarrier(c);
        const scalars: ScalarForm = {
          legalBusinessName: c.legalBusinessName ?? "", dbaName: c.dbaName, contactName: c.contactName,
          contactEmail: c.contactEmail, contactPhone: c.contactPhone, businessAddress: c.businessAddress,
          ein: c.ein, dotNumber: c.dotNumber, mcNumber: c.mcNumber, homeTerminal: c.homeTerminal,
          operatingRadiusMiles: c.operatingRadiusMiles, numberOfTrucks: c.numberOfTrucks,
          paymentPreference: c.paymentPreference, factoringCompanyName: c.factoringCompanyName,
        };
        setForm(scalars);
        savedFormRef.current = JSON.stringify(scalars);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load your application.");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Warn on unsaved scalar changes when leaving the tab.
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  function setField<K extends keyof ScalarForm>(key: K, value: ScalarForm[K]) {
    setForm((prev) => { const next = { ...prev, [key]: value }; setDirty(JSON.stringify(next) !== savedFormRef.current); return next; });
  }

  async function saveScalars(): Promise<boolean> {
    setSaving(true); setError(null);
    try {
      const saved = await saveApplication(form);
      setCarrier(saved);
      savedFormRef.current = JSON.stringify(form);
      setDirty(false);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
      return false;
    } finally { setSaving(false); }
  }

  // Step-level validation (only the two scalar steps have required fields here;
  // the collection steps validate within their own components).
  function validateStep(i: number): string | null {
    if (i === 0 && !form.legalBusinessName.trim()) return "Legal business name is required.";
    if (i === 1) {
      if (!form.dotNumber?.trim()) return "DOT number is required.";
      if (!form.mcNumber?.trim()) return "MC number is required.";
    }
    return null;
  }

  async function next() {
    const v = validateStep(step);
    setStepError(v);
    if (v) return;
    // Persist scalar steps before advancing.
    if (step <= 1 || step === 6) { const ok = await saveScalars(); if (!ok) return; }
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  }
  function back() { setStepError(null); setStep((s) => Math.max(s - 1, 0)); }

  const completion = Math.round(((step + 1) / STEPS.length) * 100);

  if (loading) return <div className="mx-auto max-w-3xl px-6 py-10 text-sm text-slate-400">Loading your application…</div>;

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-900">Carrier application</h1>
        <p className="mt-1 text-sm text-slate-500">Complete each step. Your progress is saved as you go — you can leave and come back.</p>
      </header>

      {/* Progress */}
      <div className="mb-6">
        <div className="flex items-center justify-between text-xs text-slate-500">
          <span>Step {step + 1} of {STEPS.length}: <span className="font-medium text-slate-800">{STEPS[step]}</span></span>
          <span>{completion}% complete</span>
        </div>
        <div className="mt-2 h-2 w-full rounded-full bg-slate-100">
          <div className="h-2 rounded-full bg-slate-900 transition-all" style={{ width: `${completion}%` }} />
        </div>
      </div>

      {error && <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      <div className="rounded-lg border border-slate-200 bg-white p-6">
        {step === 0 && <CompanyStep form={form} setField={setField} />}
        {step === 1 && <AuthorityStep form={form} setField={setField} />}
        {step === 2 && <InsuranceStep />}
        {step === 3 && <DocumentsStep carrier={carrier} onChange={load} />}
        {step === 4 && <EquipmentStep />}
        {step === 5 && <LanesStep form={form} setField={setField} onSaveRadius={saveScalars} />}
        {step === 6 && <FactoringStep form={form} setField={setField} />}
        {step === 7 && <ReviewStep carrier={carrier} form={form} onSubmitted={load} />}

        {stepError && <p className="mt-4 text-sm text-red-600">{stepError}</p>}
      </div>

      <div className="mt-6 flex items-center justify-between">
        <button onClick={back} disabled={step === 0} className="rounded-md border border-slate-300 px-4 py-2 text-sm text-slate-700 disabled:opacity-40 hover:bg-slate-50">Back</button>
        <div className="flex items-center gap-3">
          {dirty && <span className="text-xs text-amber-600">Unsaved changes</span>}
          {step < STEPS.length - 1 && (
            <button onClick={next} disabled={saving} className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
              {saving ? "Saving…" : "Save & continue"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- Field helpers ----
function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-slate-700">{label}{required && <span className="text-red-500"> *</span>}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}
const input = "w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none";

function CompanyStep({ form, setField }: { form: ScalarForm; setField: <K extends keyof ScalarForm>(k: K, v: ScalarForm[K]) => void }) {
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-slate-900">Company information</h2>
      <Field label="Legal business name" required><input className={input} value={form.legalBusinessName} onChange={(e) => setField("legalBusinessName", e.target.value)} /></Field>
      <Field label="DBA (if different)"><input className={input} value={form.dbaName ?? ""} onChange={(e) => setField("dbaName", e.target.value)} /></Field>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Contact name"><input className={input} value={form.contactName ?? ""} onChange={(e) => setField("contactName", e.target.value)} /></Field>
        <Field label="Contact email"><input className={input} type="email" value={form.contactEmail ?? ""} onChange={(e) => setField("contactEmail", e.target.value)} /></Field>
      </div>
      <Field label="Contact phone"><input className={input} value={form.contactPhone ?? ""} onChange={(e) => setField("contactPhone", e.target.value)} /></Field>
      <Field label="Business address"><input className={input} value={form.businessAddress ?? ""} onChange={(e) => setField("businessAddress", e.target.value)} /></Field>
      <Field label="EIN"><input className={input} value={form.ein ?? ""} onChange={(e) => setField("ein", e.target.value)} /></Field>
    </div>
  );
}

function AuthorityStep({ form, setField }: { form: ScalarForm; setField: <K extends keyof ScalarForm>(k: K, v: ScalarForm[K]) => void }) {
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-slate-900">DOT/MC & authority</h2>
      <p className="text-xs text-slate-400">These must be unique. If another carrier already uses this DOT or MC number, you'll see an error when you save.</p>
      <div className="grid grid-cols-2 gap-4">
        <Field label="DOT number" required><input className={input} value={form.dotNumber ?? ""} onChange={(e) => setField("dotNumber", e.target.value)} /></Field>
        <Field label="MC number" required><input className={input} value={form.mcNumber ?? ""} onChange={(e) => setField("mcNumber", e.target.value)} /></Field>
      </div>
      <Field label="Home terminal"><input className={input} value={form.homeTerminal ?? ""} onChange={(e) => setField("homeTerminal", e.target.value)} /></Field>
    </div>
  );
}

function ReviewStep({ carrier, form, onSubmitted }: { carrier: CarrierRecord | null; form: ScalarForm; onSubmitted: () => void }) {
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [missing, setMissing] = useState<string[] | null>(null);
  const alreadySubmitted = carrier && carrier.status !== "APPLICATION_STARTED";

  async function submit() {
    setSubmitting(true); setMissing(null); setResult(null);
    try {
      const r = await submitApplication();
      if (r.missing && r.missing.length) { setMissing(r.missing); return; }
      setResult(r.status);
      onSubmitted();
    } catch (e) {
      setResult(e instanceof Error ? e.message : "Submit failed.");
    } finally { setSubmitting(false); }
  }

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-slate-900">Review & submit</h2>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <div><dt className="text-xs text-slate-400">Legal name</dt><dd className="text-slate-900">{form.legalBusinessName || "—"}</dd></div>
        <div><dt className="text-xs text-slate-400">DOT / MC</dt><dd className="text-slate-900">{form.dotNumber || "—"} / {form.mcNumber || "—"}</dd></div>
        <div><dt className="text-xs text-slate-400">Home terminal</dt><dd className="text-slate-900">{form.homeTerminal || "—"}</dd></div>
        <div><dt className="text-xs text-slate-400">Trucks</dt><dd className="text-slate-900">{form.numberOfTrucks ?? "—"}</dd></div>
      </dl>

      {alreadySubmitted ? (
        <div className="rounded-md bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          Your application has been submitted (status: {carrier!.status.replace(/_/g, " ")}). You can still upload documents and update details from your dashboard.
        </div>
      ) : (
        <>
          <p className="text-sm text-slate-500">Submitting moves your application into review. You can still upload documents afterward.</p>
          {missing && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              Before submitting, please complete: <span className="font-medium">{missing.join(", ")}</span>
            </div>
          )}
          <button onClick={submit} disabled={submitting} className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
            {submitting ? "Submitting…" : "Submit application"}
          </button>
        </>
      )}
      {result && !missing && <p className="text-sm text-emerald-700">Submitted. Status: {result.replace(/_/g, " ")}.</p>}
    </div>
  );
}
