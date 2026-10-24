"use client";

import { useEffect, useState } from "react";
import {
  listInsurance, saveInsurance, deleteInsurance, INSURANCE_TYPES, type InsurancePolicy, type InsuranceType,
  listEquipment, saveEquipment, deleteEquipment, type Equipment,
  listLanes, saveLane, deleteLane, type Lane,
  uploadCarrierDocument, uploadFactoringDocument, CARRIER_DOC_TYPES, type CarrierDocType,
  documentState, insuranceWarning, daysUntil, acknowledgeAgreement,
  type CarrierRecord, type CarrierApplicationInput,
} from "./carrier-api";

const input = "w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none";
const btn = "rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50";
const btnGhost = "rounded-md border border-slate-300 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50";

function useAsyncError() {
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>) => { setError(null); try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : "Something went wrong."); } };
  return { error, run };
}

// ---- Insurance ----
export function InsuranceStep() {
  const [policies, setPolicies] = useState<InsurancePolicy[]>([]);
  const [draft, setDraft] = useState<{ type: InsuranceType; insurerName: string; policyNumber: string; coverage: string; effectiveAt: string; expiresAt: string }>(
    { type: "AUTO_LIABILITY", insurerName: "", policyNumber: "", coverage: "", effectiveAt: "", expiresAt: "" });
  const { error, run } = useAsyncError();
  const refresh = () => run(async () => setPolicies(await listInsurance()));
  useEffect(() => { refresh(); }, []);

  const add = () => run(async () => {
    await saveInsurance({
      type: draft.type, insurerName: draft.insurerName || undefined, policyNumber: draft.policyNumber || undefined,
      coverageCents: draft.coverage ? Math.round(parseFloat(draft.coverage) * 100) : undefined,
      effectiveAt: draft.effectiveAt ? new Date(draft.effectiveAt).toISOString() : undefined,
      expiresAt: draft.expiresAt ? new Date(draft.expiresAt).toISOString() : undefined,
    });
    setDraft({ type: "AUTO_LIABILITY", insurerName: "", policyNumber: "", coverage: "", effectiveAt: "", expiresAt: "" });
    await refresh();
  });

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-slate-900">Insurance</h2>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {policies.length > 0 && (
        <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">
          {policies.map((p) => (
            <li key={p.id} className="flex items-center justify-between px-3 py-2 text-sm">
              <div>
                <span className="font-medium text-slate-800">{p.type.replace(/_/g, " ")}</span>
                <span className="text-slate-400"> · {p.insurerName || "insurer TBD"} · exp {p.expiresAt ? new Date(p.expiresAt).toLocaleDateString() : "—"}</span>
                <InsuranceBanner expiresAt={p.expiresAt} />
              </div>
              <button className={btnGhost} onClick={() => run(async () => { await deleteInsurance(p.id); await refresh(); })}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      <div className="rounded-md border border-slate-200 p-3">
        <p className="mb-2 text-sm font-medium text-slate-700">Add a policy</p>
        <div className="grid grid-cols-2 gap-3">
          <select className={input} value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value as InsuranceType })}>
            {INSURANCE_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}
          </select>
          <input className={input} placeholder="Insurer" value={draft.insurerName} onChange={(e) => setDraft({ ...draft, insurerName: e.target.value })} />
          <input className={input} placeholder="Policy number" value={draft.policyNumber} onChange={(e) => setDraft({ ...draft, policyNumber: e.target.value })} />
          <input className={input} placeholder="Coverage (USD)" value={draft.coverage} onChange={(e) => setDraft({ ...draft, coverage: e.target.value })} />
          <label className="text-xs text-slate-500">Effective<input className={input} type="date" value={draft.effectiveAt} onChange={(e) => setDraft({ ...draft, effectiveAt: e.target.value })} /></label>
          <label className="text-xs text-slate-500">Expires<input className={input} type="date" value={draft.expiresAt} onChange={(e) => setDraft({ ...draft, expiresAt: e.target.value })} /></label>
        </div>
        <button className={`${btn} mt-3`} onClick={add}>Add policy</button>
      </div>
    </div>
  );
}

export function InsuranceBanner({ expiresAt }: { expiresAt: string | null }) {
  const w = insuranceWarning(expiresAt);
  if (w === "NONE") return null;
  const d = daysUntil(expiresAt);
  const map = {
    UPCOMING: { text: `Upcoming expiration (${d}d)`, cls: "bg-sky-100 text-sky-800" },
    RENEWAL: { text: `Renewal needed (${d}d)`, cls: "bg-amber-100 text-amber-800" },
    URGENT: { text: `Urgent — expires in ${d}d`, cls: "bg-orange-100 text-orange-800" },
    EXPIRED: { text: "Expired — action required", cls: "bg-red-100 text-red-800" },
  } as const;
  const m = map[w];
  return <span className={`ml-2 inline-block rounded-full px-2 py-0.5 text-xs font-medium ${m.cls}`}>{m.text}</span>;
}

// ---- Documents (W-9 & agreements step) ----
const REQUIRED_DOCS: { type: CarrierDocType; label: string }[] = [
  { type: "W9", label: "W-9" },
  { type: "CERTIFICATE_OF_INSURANCE", label: "Certificate of insurance" },
  { type: "AUTHORITY_LETTER", label: "Authority letter" },
  { type: "CARRIER_AGREEMENT", label: "Carrier agreement" },
];

export function DocumentsStep({ carrier, onChange }: { carrier: CarrierRecord | null; onChange: () => void }) {
  const { error, run } = useAsyncError();
  const [uploading, setUploading] = useState<string | null>(null);
  const [signer, setSigner] = useState("");
  const docs = carrier?.documents ?? [];
  const currentByType = (t: string) => docs.filter((d) => documentState(d) !== "SUPERSEDED").find((d) => d.type === t);

  const upload = (type: CarrierDocType, file: File) => run(async () => {
    setUploading(type);
    try { await uploadCarrierDocument({ documentType: type, file }); await onChange(); } finally { setUploading(null); }
  });

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-slate-900">W-9 & agreements</h2>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <ul className="space-y-2">
        {REQUIRED_DOCS.map(({ type, label }) => {
          const doc = currentByType(type);
          const state = documentState(doc);
          return (
            <li key={type} className="rounded-md border border-slate-200 p-3">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-sm font-medium text-slate-800">{label}</span>
                  <DocStateBadge state={state} />
                </div>
                <label className={`${btnGhost} cursor-pointer`}>
                  {uploading === type ? "Uploading…" : state === "MISSING" ? "Upload" : "Replace"}
                  <input type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(type, f); }} />
                </label>
              </div>
              {state === "REJECTED" && doc?.rejectionReason && (
                <p className="mt-2 rounded bg-red-50 px-2 py-1 text-xs text-red-700">Rejected: {doc.rejectionReason}. Please upload a replacement.</p>
              )}
            </li>
          );
        })}
      </ul>

      <div className="rounded-md border border-slate-200 p-3">
        <p className="text-sm font-medium text-slate-700">Acknowledge dispatch agreement</p>
        <p className="mb-2 text-xs text-slate-400">Type your name to acknowledge the current dispatch agreement.</p>
        <div className="flex gap-2">
          <input className={input} placeholder="Your full name" value={signer} onChange={(e) => setSigner(e.target.value)} />
          <button className={btn} disabled={!signer.trim()} onClick={() => run(async () => { await acknowledgeAgreement({ agreementType: "DISPATCH", signedByName: signer }); setSigner(""); await onChange(); })}>Acknowledge</button>
        </div>
      </div>
    </div>
  );
}

export function DocStateBadge({ state }: { state: string }) {
  const map: Record<string, string> = {
    MISSING: "bg-slate-100 text-slate-500", UPLOADING: "bg-slate-100 text-slate-500",
    PENDING_REVIEW: "bg-amber-100 text-amber-800", APPROVED: "bg-emerald-100 text-emerald-800",
    REJECTED: "bg-red-100 text-red-800", EXPIRED: "bg-red-100 text-red-800", SUPERSEDED: "bg-slate-200 text-slate-400",
  };
  return <span className={`ml-2 inline-block rounded-full px-2 py-0.5 text-xs font-medium ${map[state] ?? "bg-slate-100 text-slate-500"}`}>{state.replace(/_/g, " ").toLowerCase()}</span>;
}

// ---- Equipment ----
export function EquipmentStep() {
  const [items, setItems] = useState<Equipment[]>([]);
  const [draft, setDraft] = useState({ equipmentType: "", make: "", unitNumber: "", hasLiftgate: false });
  const { error, run } = useAsyncError();
  const refresh = () => run(async () => setItems(await listEquipment()));
  useEffect(() => { refresh(); }, []);
  const add = () => run(async () => {
    if (!draft.equipmentType.trim()) return;
    await saveEquipment({ equipmentType: draft.equipmentType, make: draft.make || undefined, unitNumber: draft.unitNumber || undefined, hasLiftgate: draft.hasLiftgate });
    setDraft({ equipmentType: "", make: "", unitNumber: "", hasLiftgate: false }); await refresh();
  });
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-slate-900">Equipment & fleet</h2>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {items.length > 0 && (
        <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">
          {items.map((e) => (
            <li key={e.id} className="flex items-center justify-between px-3 py-2 text-sm">
              <span className="text-slate-800">{e.equipmentType}{e.make ? ` · ${e.make}` : ""}{e.unitNumber ? ` · #${e.unitNumber}` : ""}{e.hasLiftgate ? " · liftgate" : ""}</span>
              <button className={btnGhost} onClick={() => run(async () => { await deleteEquipment(e.id); await refresh(); })}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      <div className="rounded-md border border-slate-200 p-3">
        <div className="grid grid-cols-2 gap-3">
          <input className={input} placeholder="Equipment type (e.g. 26ft box, dry van)" value={draft.equipmentType} onChange={(e) => setDraft({ ...draft, equipmentType: e.target.value })} />
          <input className={input} placeholder="Make" value={draft.make} onChange={(e) => setDraft({ ...draft, make: e.target.value })} />
          <input className={input} placeholder="Unit number" value={draft.unitNumber} onChange={(e) => setDraft({ ...draft, unitNumber: e.target.value })} />
          <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={draft.hasLiftgate} onChange={(e) => setDraft({ ...draft, hasLiftgate: e.target.checked })} /> Has liftgate</label>
        </div>
        <button className={`${btn} mt-3`} onClick={add}>Add equipment</button>
      </div>
    </div>
  );
}

// ---- Lanes + operating radius ----
export function LanesStep({ form, setField, onSaveRadius }: {
  form: CarrierApplicationInput; setField: <K extends keyof CarrierApplicationInput>(k: K, v: CarrierApplicationInput[K]) => void; onSaveRadius: () => Promise<boolean>;
}) {
  const [lanes, setLanes] = useState<Lane[]>([]);
  const [draft, setDraft] = useState({ originState: "", originMetro: "", destinationState: "", destinationMetro: "" });
  const { error, run } = useAsyncError();
  const refresh = () => run(async () => setLanes(await listLanes()));
  useEffect(() => { refresh(); }, []);
  const add = () => run(async () => {
    await saveLane({ originState: draft.originState || undefined, originMetro: draft.originMetro || undefined, destinationState: draft.destinationState || undefined, destinationMetro: draft.destinationMetro || undefined });
    setDraft({ originState: "", originMetro: "", destinationState: "", destinationMetro: "" }); await refresh();
  });
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-slate-900">Preferred lanes & operating radius</h2>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <label className="block">
        <span className="text-sm font-medium text-slate-700">Operating radius (miles)</span>
        <div className="mt-1 flex gap-2">
          <input className={input} type="number" value={form.operatingRadiusMiles ?? ""} onChange={(e) => setField("operatingRadiusMiles", e.target.value ? parseInt(e.target.value) : undefined)} />
          <button className={btnGhost} onClick={() => onSaveRadius()}>Save</button>
        </div>
      </label>
      {lanes.length > 0 && (
        <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">
          {lanes.map((l) => (
            <li key={l.id} className="flex items-center justify-between px-3 py-2 text-sm">
              <span className="text-slate-800">{[l.originMetro, l.originState].filter(Boolean).join(", ") || "Any"} → {[l.destinationMetro, l.destinationState].filter(Boolean).join(", ") || "Any"}</span>
              <button className={btnGhost} onClick={() => run(async () => { await deleteLane(l.id); await refresh(); })}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      <div className="rounded-md border border-slate-200 p-3">
        <p className="mb-2 text-sm font-medium text-slate-700">Add a preferred lane</p>
        <div className="grid grid-cols-4 gap-2">
          <input className={input} placeholder="Orig ST" value={draft.originState} onChange={(e) => setDraft({ ...draft, originState: e.target.value.toUpperCase() })} />
          <input className={input} placeholder="Orig metro" value={draft.originMetro} onChange={(e) => setDraft({ ...draft, originMetro: e.target.value })} />
          <input className={input} placeholder="Dest ST" value={draft.destinationState} onChange={(e) => setDraft({ ...draft, destinationState: e.target.value.toUpperCase() })} />
          <input className={input} placeholder="Dest metro" value={draft.destinationMetro} onChange={(e) => setDraft({ ...draft, destinationMetro: e.target.value })} />
        </div>
        <button className={`${btn} mt-3`} onClick={add}>Add lane</button>
      </div>
    </div>
  );
}

// ---- Factoring ----
export function FactoringStep({ form, setField }: {
  form: CarrierApplicationInput; setField: <K extends keyof CarrierApplicationInput>(k: K, v: CarrierApplicationInput[K]) => void;
}) {
  const { error, run } = useAsyncError();
  const [uploading, setUploading] = useState<string | null>(null);
  const uses = form.paymentPreference === "FACTORING";
  const upload = (type: "NOTICE_OF_ASSIGNMENT" | "RELEASE_OF_ASSIGNMENT" | "REMITTANCE_INSTRUCTIONS", file: File) => run(async () => {
    setUploading(type); try { await uploadFactoringDocument({ documentType: type, file }); } finally { setUploading(null); }
  });
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-slate-900">Factoring & payment routing</h2>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <label className="block">
        <span className="text-sm font-medium text-slate-700">Payment preference</span>
        <select className={`${input} mt-1`} value={form.paymentPreference ?? ""} onChange={(e) => setField("paymentPreference", (e.target.value || undefined) as CarrierApplicationInput["paymentPreference"])}>
          <option value="">Select…</option>
          <option value="DIRECT_DEPOSIT">Direct deposit</option>
          <option value="FACTORING">Factoring</option>
          <option value="QUICK_PAY">Quick pay</option>
        </select>
      </label>
      {uses && (
        <>
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Factoring company</span>
            <input className={`${input} mt-1`} value={form.factoringCompanyName ?? ""} onChange={(e) => setField("factoringCompanyName", e.target.value)} />
          </label>
          <div className="rounded-md border border-slate-200 p-3">
            <p className="mb-1 text-sm font-medium text-slate-700">Factoring documents</p>
            <p className="mb-3 text-xs text-slate-400">Once a Notice of Assignment is verified, the remittance destination is locked — changes go to admin review. This protects you and your factor.</p>
            {([["NOTICE_OF_ASSIGNMENT", "Notice of Assignment"], ["RELEASE_OF_ASSIGNMENT", "Letter of Release"], ["REMITTANCE_INSTRUCTIONS", "Remittance instructions"]] as const).map(([type, label]) => (
              <label key={type} className={`${btnGhost} mr-2 mb-2 inline-block cursor-pointer`}>
                {uploading === type ? "Uploading…" : `Upload ${label}`}
                <input type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(type, f); }} />
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
