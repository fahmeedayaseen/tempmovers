"use client";

import { useEffect, useState } from "react";
import { authFetch, fetchCurrentUser, NotSignedInError } from "@/lib/client-auth";

type Step = { key: string; label?: string; status: "NOT_APPLICABLE" | "NOT_STARTED" | "IN_PROGRESS" | "COMPLETE" };
type Progress = {
  percentComplete: number;
  accountStatus: string;
  onboardingStatus: string;
  verificationStatus: string;
  complianceStatus: string;
  workerType: string;
  nextRequiredStep: string | null;
  steps: Step[];
  warnings: string[];
};

const STEP_LABELS: Record<string, string> = {
  personal: "Personal profile", business: "Business & carrier profile", vehicle: "Vehicle profile",
  credentials: "Identity & background", insurance: "Insurance", dotMc: "DOT/MC verification",
  payments: "Payments & tax setup (Stripe Connect)", subscription: "Subscription plan", territory: "Market & territory",
};

function StatusBadge({ status }: { status: Step["status"] }) {
  const styleMap: Record<Step["status"], { bg: string; fg: string; text: string }> = {
    COMPLETE: { bg: "#e3f7f2", fg: "#0f7e6b", text: "Complete" },
    IN_PROGRESS: { bg: "#fff2dc", fg: "#9a6114", text: "In progress" },
    NOT_STARTED: { bg: "#f3f6fb", fg: "#637089", text: "Not started" },
    NOT_APPLICABLE: { bg: "#f3f6fb", fg: "#9aa5b5", text: "Not applicable" },
  };
  const s = styleMap[status];
  return <span style={{ fontSize: 11, fontWeight: 800, padding: "4px 10px", borderRadius: 20, background: s.bg, color: s.fg }}>{s.text}</span>;
}

function fieldStyle() {
  return { width: "100%", padding: 10, border: "1px solid #dce4ef", borderRadius: 8, marginTop: 6 } as const;
}
function labelStyle() {
  return { display: "block", fontSize: 12, fontWeight: 700, color: "#637089", marginBottom: 4 } as const;
}
function saveButtonStyle(busy: boolean) {
  return { marginTop: 16, width: "100%", padding: 12, borderRadius: 8, border: "none", fontWeight: 800, background: busy ? "#dce4ef" : "#246bfd", color: busy ? "#637089" : "white", cursor: busy ? "default" : "pointer" } as const;
}
function messageStyle() {
  return { marginTop: 10, fontSize: 12.5, color: "#637089" } as const;
}

/** Personal profile form. */
function PersonalForm({ onSaved }: { onSaved: () => void }) {
  const [legalName, setLegalName] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    authFetch("/api/driver/profile").then((r) => r.json()).then((d) => {
      if (d.legalName) setLegalName(d.legalName);
      if (d.dateOfBirth) setDateOfBirth(new Date(d.dateOfBirth).toISOString().slice(0, 10));
    }).catch(() => {});
  }, []);

  async function save() {
    setBusy(true); setMessage(null);
    try {
      const res = await authFetch("/api/driver/profile", { method: "POST", body: JSON.stringify({ legalName, dateOfBirth }) });
      const data = await res.json();
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "Could not save.");
      setMessage("Saved.");
      onSaved();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <label style={labelStyle()}>Legal name</label>
      <input style={fieldStyle()} value={legalName} onChange={(e) => setLegalName(e.target.value)} placeholder="Jordan Casey" />
      <label style={{ ...labelStyle(), marginTop: 12 }}>Date of birth</label>
      <input type="date" style={fieldStyle()} value={dateOfBirth} onChange={(e) => setDateOfBirth(e.target.value)} />
      <button disabled={busy || !legalName || !dateOfBirth} onClick={save} style={saveButtonStyle(busy)}>
        {busy ? "Saving…" : "Save and continue"}
      </button>
      {message && <p style={messageStyle()}>{message}</p>}
    </div>
  );
}

/** Business/carrier profile — semi drivers only. */
function BusinessForm({ onSaved }: { onSaved: () => void }) {
  const [businessName, setBusinessName] = useState("");
  const [usdotNumber, setUsdotNumber] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [applicable, setApplicable] = useState(true);

  useEffect(() => {
    authFetch("/api/driver/business").then((r) => r.json()).then((d) => {
      if (d.applicable === false) { setApplicable(false); return; }
      if (d.businessName) setBusinessName(d.businessName);
      if (d.carrierVerification?.usdotNumber) setUsdotNumber(d.carrierVerification.usdotNumber);
    }).catch(() => {});
  }, []);

  if (!applicable) return <p style={{ color: "#637089", fontSize: 13 }}>Not applicable — this step is only for semi-truck carrier accounts.</p>;

  async function save() {
    setBusy(true); setMessage(null);
    try {
      const res = await authFetch("/api/driver/business", { method: "POST", body: JSON.stringify({ businessName, usdotNumber }) });
      const data = await res.json();
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "Could not save.");
      setMessage("Saved — FMCSA verification requested.");
      onSaved();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <label style={labelStyle()}>Legal business name</label>
      <input style={fieldStyle()} value={businessName} onChange={(e) => setBusinessName(e.target.value)} placeholder="Casey Freight LLC" />
      <label style={{ ...labelStyle(), marginTop: 12 }}>USDOT number</label>
      <input style={fieldStyle()} value={usdotNumber} onChange={(e) => setUsdotNumber(e.target.value)} placeholder="1234567" />
      <button disabled={busy || !businessName || !usdotNumber} onClick={save} style={saveButtonStyle(busy)}>
        {busy ? "Saving…" : "Save and continue"}
      </button>
      {message && <p style={messageStyle()}>{message}</p>}
    </div>
  );
}

/** Vehicle + insurance — box-truck/semi carriers only. */
function VehicleForm({ onSaved }: { onSaved: () => void }) {
  const [type, setType] = useState<"BOX_TRUCK" | "SEMI_TRACTOR_TRAILER">("BOX_TRUCK");
  const [year, setYear] = useState("");
  const [make, setMake] = useState("");
  const [model, setModel] = useState("");
  const [plateNumber, setPlateNumber] = useState("");
  const [plateState, setPlateState] = useState("IN");
  const [commercialInsurance, setCommercialInsurance] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [applicable, setApplicable] = useState(true);

  useEffect(() => {
    authFetch("/api/driver/vehicles").then((r) => r.json()).then((d) => {
      if (d.applicable === false) { setApplicable(false); return; }
      if (d.vehicle) {
        setType(d.vehicle.type); setYear(String(d.vehicle.year ?? "")); setMake(d.vehicle.make ?? ""); setModel(d.vehicle.model ?? "");
        setPlateNumber(d.vehicle.plateNumber ?? ""); setPlateState(d.vehicle.plateState ?? "IN");
        setCommercialInsurance(!!d.vehicle.commercialInsurance);
      }
    }).catch(() => {});
  }, []);

  if (!applicable) return <p style={{ color: "#637089", fontSize: 13 }}>Not applicable — labor-only movers don&apos;t need a vehicle profile.</p>;

  async function save() {
    setBusy(true); setMessage(null);
    try {
      const res = await authFetch("/api/driver/vehicles", {
        method: "POST",
        body: JSON.stringify({ type, year: Number(year), make, model, plateNumber, plateState, commercialInsurance }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "Could not save.");
      setMessage("Saved.");
      onSaved();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <label style={labelStyle()}>Vehicle type</label>
      <select style={fieldStyle()} value={type} onChange={(e) => setType(e.target.value as typeof type)}>
        <option value="BOX_TRUCK">Box truck</option>
        <option value="SEMI_TRACTOR_TRAILER">Semi tractor-trailer</option>
      </select>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginTop: 12 }}>
        <div><label style={labelStyle()}>Year</label><input style={fieldStyle()} value={year} onChange={(e) => setYear(e.target.value)} /></div>
        <div><label style={labelStyle()}>Make</label><input style={fieldStyle()} value={make} onChange={(e) => setMake(e.target.value)} /></div>
        <div><label style={labelStyle()}>Model</label><input style={fieldStyle()} value={model} onChange={(e) => setModel(e.target.value)} /></div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 8, marginTop: 12 }}>
        <div><label style={labelStyle()}>License plate</label><input style={fieldStyle()} value={plateNumber} onChange={(e) => setPlateNumber(e.target.value)} /></div>
        <div><label style={labelStyle()}>State</label><input style={fieldStyle()} maxLength={2} value={plateState} onChange={(e) => setPlateState(e.target.value.toUpperCase())} /></div>
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 14, fontSize: 13 }}>
        <input type="checkbox" checked={commercialInsurance} onChange={(e) => setCommercialInsurance(e.target.checked)} />
        I have active commercial auto + cargo insurance for this vehicle
      </label>
      <button disabled={busy || !year || !make || !model || !plateNumber} onClick={save} style={saveButtonStyle(busy)}>
        {busy ? "Saving…" : "Save and continue"}
      </button>
      {message && <p style={messageStyle()}>{message}</p>}
    </div>
  );
}

/** Service territory — home ZIP already set at signup, this just sets radius. */
/** Shared shape for the three verification-track forms below. */
const DOCUMENT_TYPE_BY_TRACK: Record<"IDENTITY" | "VEHICLE" | "INSURANCE" | "DOT_MC", string> = {
  IDENTITY: "DRIVERS_LICENSE", VEHICLE: "VEHICLE_REGISTRATION", INSURANCE: "CERTIFICATE_OF_INSURANCE", DOT_MC: "OPERATING_AUTHORITY",
};

function useVerificationSubmit(track: "IDENTITY" | "VEHICLE" | "INSURANCE" | "DOT_MC") {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(file: File, expiresAt: string | undefined, onSaved: () => void) {
    setBusy(true); setMessage(null);
    try {
      const me = await fetchCurrentUser();
      if (!me.workerId) throw new Error("No worker profile found.");

      // 1. Ask for a signed upload URL — the file never passes through our
      // own server, only S3.
      const presignRes = await authFetch("/api/uploads/presign", {
        method: "POST",
        body: JSON.stringify({ documentType: DOCUMENT_TYPE_BY_TRACK[track], contentType: file.type, contentLength: file.size }),
      });
      const presignData = await presignRes.json();
      if (!presignRes.ok) throw new Error(typeof presignData.error === "string" ? presignData.error : "Could not start upload.");

      // 2. Upload the actual file bytes directly to S3.
      const putRes = await fetch(presignData.uploadUrl, { method: "PUT", headers: { "Content-Type": file.type }, body: file });
      if (!putRes.ok) throw new Error("File upload failed. Try again.");

      // 3. Record the document — documentUrl is the private S3 key
      // returned above, resolved to a signed download URL only when
      // actually accessed.
      const res = await authFetch(`/api/workers/${me.workerId}/verification`, {
        method: "POST",
        body: JSON.stringify({ track, documentUrl: presignData.key, ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "Could not submit.");
      setMessage("Submitted for review.");
      onSaved();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return { busy, message, submit };
}

/** Identity/background credentials — driver's license or ID document. Required for every worker type. */
function CredentialsForm({ onSaved }: { onSaved: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const { busy, message, submit } = useVerificationSubmit("IDENTITY");

  return (
    <div>
      <label style={labelStyle()}>Driver&apos;s license or identity document</label>
      <input type="file" accept="image/jpeg,image/png,image/webp,image/heic,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} style={fieldStyle()} />
      <button disabled={busy || !file} onClick={() => file && submit(file, undefined, onSaved)} style={saveButtonStyle(busy)}>
        {busy ? "Uploading…" : "Submit credentials"}
      </button>
      {message && <p style={messageStyle()}>{message}</p>}
    </div>
  );
}

/** Certificate of insurance — only rendered for worker types where insurance is applicable (see VehicleForm's applicability check; this one accepts the submission regardless, the eligibility evaluator gates whether it's required). */
function InsuranceForm({ onSaved }: { onSaved: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [expiresAt, setExpiresAt] = useState("");
  const { busy, message, submit } = useVerificationSubmit("INSURANCE");

  return (
    <div>
      <label style={labelStyle()}>Certificate of insurance</label>
      <input type="file" accept="image/jpeg,image/png,image/webp,image/heic,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} style={fieldStyle()} />
      <label style={{ ...labelStyle(), marginTop: 12 }}>Policy expiration</label>
      <input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} style={fieldStyle()} />
      <button disabled={busy || !file} onClick={() => file && submit(file, expiresAt || undefined, onSaved)} style={saveButtonStyle(busy)}>
        {busy ? "Uploading…" : "Submit insurance"}
      </button>
      {message && <p style={messageStyle()}>{message}</p>}
    </div>
  );
}

/** Operating authority (DOT/MC) — semi carriers. */
function DotMcForm({ onSaved }: { onSaved: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const { busy, message, submit } = useVerificationSubmit("DOT_MC");

  return (
    <div>
      <label style={labelStyle()}>Operating authority document</label>
      <input type="file" accept="image/jpeg,image/png,image/webp,image/heic,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} style={fieldStyle()} />
      <button disabled={busy || !file} onClick={() => file && submit(file, undefined, onSaved)} style={saveButtonStyle(busy)}>
        {busy ? "Uploading…" : "Submit DOT/MC document"}
      </button>
      {message && <p style={messageStyle()}>{message}</p>}
    </div>
  );
}

function TerritoryForm({ onSaved }: { onSaved: () => void }) {
  const [serviceRadiusMiles, setServiceRadiusMiles] = useState("30");
  const [homeZip, setHomeZip] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    authFetch("/api/driver/territories").then((r) => r.json()).then((d) => {
      setHomeZip(d.homeZip ?? null);
      const mine = d.workerMarkets?.[0];
      if (mine?.serviceRadiusMiles) setServiceRadiusMiles(String(mine.serviceRadiusMiles));
    }).catch(() => {});
  }, []);

  async function save() {
    setBusy(true); setMessage(null);
    try {
      const res = await authFetch("/api/driver/territories", { method: "POST", body: JSON.stringify({ serviceRadiusMiles: Number(serviceRadiusMiles) }) });
      const data = await res.json();
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "Could not save.");
      setMessage("Saved.");
      onSaved();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p style={{ fontSize: 13, color: "#637089", marginBottom: 12 }}>Home ZIP: {homeZip ?? "—"} (set at signup)</p>
      <label style={labelStyle()}>Service radius (miles)</label>
      <input type="number" style={fieldStyle()} value={serviceRadiusMiles} onChange={(e) => setServiceRadiusMiles(e.target.value)} />
      <button disabled={busy} onClick={save} style={saveButtonStyle(busy)}>{busy ? "Saving…" : "Save and continue"}</button>
      {message && <p style={messageStyle()}>{message}</p>}
    </div>
  );
}

/** Stripe Connect — redirects out to the real onboarding flow. */
function PaymentsSection() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function start() {
    setBusy(true); setMessage(null);
    try {
      const me = await fetchCurrentUser();
      if (!me.workerId) throw new Error("No worker profile found.");
      const res = await authFetch("/api/stripe/connect-onboarding", { method: "POST", body: JSON.stringify({ workerId: me.workerId }) });
      const data = await res.json();
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "Could not start Stripe onboarding.");
      window.location.href = data.url;
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Something went wrong.");
      setBusy(false);
    }
  }

  return (
    <div>
      <p style={{ fontSize: 13, color: "#637089", marginBottom: 12 }}>Stripe Connect handles identity verification, bank account setup, and payout eligibility — this redirects to Stripe&apos;s own hosted onboarding flow.</p>
      <button disabled={busy} onClick={start} style={saveButtonStyle(busy)}>{busy ? "Redirecting…" : "Start Stripe Connect onboarding"}</button>
      {message && <p style={messageStyle()}>{message}</p>}
    </div>
  );
}

/** Subscription plan selection — redirects to real Stripe Checkout. */
function SubscriptionSection({ workerType }: { workerType?: string }) {
  const [plan, setPlan] = useState<"DRIVER_BASIC" | "OWNER_OPERATOR_PRO" | "FLEET" | "MOVER">(workerType === "SEMI_DRIVER" ? "OWNER_OPERATOR_PRO" : workerType === "BOX_TRUCK_DRIVER" ? "DRIVER_BASIC" : "MOVER");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function select() {
    setBusy(true); setMessage(null);
    try {
      const res = await authFetch("/api/stripe/worker-subscription", {
        method: "POST",
        body: JSON.stringify({ plan }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "Could not start checkout.");
      if (data.status === "WAIVED_UNTIL_FIRST_COMPLETED_JOB") { setMessage(data.message); setBusy(false); return; }
      if (data.url) { window.location.href = data.url; return; }
      throw new Error("No checkout URL returned.");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Something went wrong.");
      setBusy(false);
    }
  }

  return (
    <div>
      <label style={labelStyle()}>Plan</label>
      <select style={fieldStyle()} value={plan} onChange={(e) => setPlan(e.target.value as typeof plan)}>
        {workerType === "MOVER" && <option value="MOVER">Mover — $19.95/mo</option>}
        {workerType === "BOX_TRUCK_DRIVER" && <option value="DRIVER_BASIC">Driver Basic — $29.95/mo</option>}
        {(workerType === "BOX_TRUCK_DRIVER" || workerType === "SEMI_DRIVER") && <option value="OWNER_OPERATOR_PRO">Owner-Operator Pro — $59.95/mo</option>}
        {(workerType === "BOX_TRUCK_DRIVER" || workerType === "SEMI_DRIVER") && <option value="FLEET">Fleet — $149/mo (up to 5 vehicles)</option>}
      </select>
      <button disabled={busy} onClick={select} style={saveButtonStyle(busy)}>{busy ? "Please wait…" : "Select plan"}</button>
      {message && <p style={messageStyle()}>{message}</p>}
    </div>
  );
}

type FormProps = { onSaved: () => void; workerType?: string };
const FORM_COMPONENTS: Partial<Record<string, (props: FormProps) => React.ReactElement>> = {
  personal: PersonalForm,
  business: BusinessForm,
  vehicle: VehicleForm,
  credentials: CredentialsForm,
  insurance: InsuranceForm,
  dotMc: DotMcForm,
  territory: TerritoryForm,
  payments: PaymentsSection,
  subscription: SubscriptionSection,
};

/**
 * Consolidated onboarding page: expandable sections per step, each with its
 * own real save endpoint, rather than the 14 separate route files a fully
 * literal implementation of the handoff would use. Functionally equivalent
 * (load existing values, save-and-return, refresh progress, gate final
 * submission) with far less file overhead — a deliberate scoping choice.
 */
export default function OnboardingStatusPage() {
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitMessage, setSubmitMessage] = useState<string | null>(null);
  const [openStep, setOpenStep] = useState<string | null>(null);

  function load() {
    authFetch("/api/driver/onboarding")
      .then(async (res) => {
        if (!res.ok) throw new Error(`Failed to load onboarding status (${res.status}).`);
        return res.json();
      })
      .then((data: Progress) => { setProgress(data); setOpenStep((prev) => prev ?? data.nextRequiredStep); })
      .catch((e) => setError(e instanceof NotSignedInError ? "Sign in to view your onboarding status." : e.message));
  }

  useEffect(() => { load(); }, []);

  async function submitForReview() {
    setSubmitting(true);
    setSubmitMessage(null);
    try {
      const res = await authFetch("/api/driver/onboarding/submit", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not submit for review yet.");
      setSubmitMessage("Submitted for review — an admin will approve or follow up shortly.");
      load();
    } catch (e) {
      setSubmitMessage(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  }

  if (error) return <div style={{ padding: 40, textAlign: "center", color: "#c93c4d" }}>{error}</div>;
  if (!progress) return <div style={{ padding: 40, textAlign: "center", color: "#637089" }}>Loading…</div>;

  const applicableSteps = progress.steps.filter((s) => s.status !== "NOT_APPLICABLE");
  const allComplete = applicableSteps.every((s) => s.status === "COMPLETE");

  return (
    <div style={{ maxWidth: 640, margin: "0 auto", padding: "40px 24px" }}>
      <h1 style={{ fontSize: 24, marginBottom: 6 }}>Complete your account setup</h1>
      <p style={{ color: "#637089", marginBottom: 24 }}>
        {progress.percentComplete}% complete · Account status: {progress.accountStatus} · Onboarding: {progress.onboardingStatus} · Background check: {progress.complianceStatus}
        {progress.onboardingStatus === "SUBMITTED" && " · Under review"}
      </p>
      {progress.warnings.length > 0 && (
        <div style={{ background: "#fff2dc", border: "1px solid #f5d58f", borderRadius: 10, padding: 12, marginBottom: 20, fontSize: 13, color: "#7e5911" }}>
          {progress.warnings.map((w, i) => <p key={i} style={{ margin: 0 }}>{w}</p>)}
        </div>
      )}

      <div style={{ display: "grid", gap: 10, marginBottom: 24 }}>
        {progress.steps.map((s) => {
          const Form = FORM_COMPONENTS[s.key];
          const isOpen = openStep === s.key;
          return (
            <div key={s.key} style={{ borderRadius: 10, border: "1px solid #dce4ef", overflow: "hidden" }}>
              <button
                onClick={() => setOpenStep(isOpen ? null : s.key)}
                disabled={s.status === "NOT_APPLICABLE" || !Form}
                style={{
                  width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center",
                  padding: "12px 16px", background: s.key === progress.nextRequiredStep ? "#eaf0ff" : "white",
                  border: "none", cursor: Form ? "pointer" : "default", textAlign: "left",
                }}
              >
                <span style={{ fontWeight: 700 }}>{STEP_LABELS[s.key] ?? s.key}</span>
                <StatusBadge status={s.status} />
              </button>
              {isOpen && Form && (
                <div style={{ padding: 16, borderTop: "1px solid #dce4ef" }}>
                  <Form onSaved={load} workerType={progress.workerType} />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {progress.onboardingStatus === "INCOMPLETE" || progress.onboardingStatus === "IN_PROGRESS" ? (
        <button
          disabled={!allComplete || submitting}
          onClick={submitForReview}
          style={{
            width: "100%", padding: 14, borderRadius: 10, border: "none", fontWeight: 800,
            background: allComplete ? "#246bfd" : "#dce4ef", color: allComplete ? "white" : "#637089",
            cursor: allComplete ? "pointer" : "not-allowed",
          }}
        >
          {submitting ? "Submitting…" : allComplete ? "Submit for review" : "Complete every step to submit"}
        </button>
      ) : (
        <p style={{ textAlign: "center", color: "#637089" }}>
          {progress.onboardingStatus === "SUBMITTED" ? "Your profile is with our team for review." : "Onboarding complete."}
        </p>
      )}
      {submitMessage && <p style={{ marginTop: 12, textAlign: "center", color: "#637089" }}>{submitMessage}</p>}
    </div>
  );
}
