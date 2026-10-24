"use client";

import { authFetch } from "@/lib/client-auth";

/**
 * Carrier portal API client + shared types. Every shape here mirrors the FROZEN
 * backend contracts (app/api/carriers/*). Fields the backend does not accept
 * (bank/routing numbers, internal risk notes, margins) are deliberately absent
 * — the portal cannot send or show them.
 */

export const CARRIER_DOC_TYPES = ["W9", "CERTIFICATE_OF_INSURANCE", "AUTHORITY_LETTER", "CARRIER_AGREEMENT", "OTHER"] as const;
export type CarrierDocType = (typeof CARRIER_DOC_TYPES)[number];

export type DocumentState = "MISSING" | "UPLOADING" | "PENDING_REVIEW" | "APPROVED" | "REJECTED" | "EXPIRED" | "SUPERSEDED";

export type CarrierApplicationInput = {
  legalBusinessName: string;
  dbaName?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  businessAddress?: string;
  ein?: string;
  dotNumber?: string;
  mcNumber?: string;
  homeTerminal?: string;
  operatingRadiusMiles?: number;
  numberOfTrucks?: number;
  paymentPreference?: "DIRECT_DEPOSIT" | "FACTORING" | "QUICK_PAY";
  factoringCompanyName?: string;
  marketId?: string;
};

export type CarrierDocument = {
  id: string; type: string; fileName: string | null; verified: boolean; expiresAt: string | null; createdAt: string;
  rejectionReason?: string | null; supersededById?: string | null; supersededAt?: string | null;
};
export type InsurancePolicy = {
  id: string; type: string; insurerName: string | null; policyNumber: string | null;
  coverageCents: number | null; effectiveAt: string | null; expiresAt: string | null;
};
export type Equipment = { id: string; equipmentType: string; year: number | null; make: string | null; unitNumber: string | null; hasLiftgate: boolean };
export type Lane = { id: string; originState: string | null; originMetro: string | null; destinationState: string | null; destinationMetro: string | null };
export type Agreement = { id: string; agreementType: string; active: boolean; signedAt: string | null };

export type CarrierRecord = CarrierApplicationInput & {
  id: string;
  status: string;
  statusReason: string | null;
  documents: CarrierDocument[];
  insurancePolicies: InsurancePolicy[];
  equipment: Equipment[];
  lanes: Lane[];
  agreements: Agreement[];
};

export type FactoringProfile = {
  usesFactoring: boolean;
  factoringCompanyName: string | null;
  verificationStatus: string;
  verifiedAt: string | null;
} | null;

export type PaymentAssignment = { id: string; remitToName: string; status: string } | null;

export async function getCarrier(): Promise<CarrierRecord | null> {
  const res = await authFetch("/api/carriers/application");
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Could not load carrier (${res.status}).`);
  const data = await res.json();
  return data.carrier ?? null;
}

/** Save (create or update) the application. Returns the saved carrier. Server
 * keeps status server-controlled — a save never advances status. */
export async function saveApplication(input: CarrierApplicationInput): Promise<CarrierRecord> {
  const res = await authFetch("/api/carriers/application", { method: "POST", body: JSON.stringify(input) });
  if (res.status === 409) throw new Error("A carrier with this DOT or MC number already exists.");
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.error?.formErrors?.join(", ") || `Save failed (${res.status}).`);
  }
  const data = await res.json();
  return data.carrier;
}

/** Two-step secure upload: presign → PUT to private storage → finalize. */
export async function uploadCarrierDocument(params: {
  documentType: CarrierDocType; file: File; expiresAt?: string;
}): Promise<CarrierDocument> {
  const presign = await authFetch("/api/carriers/documents", {
    method: "POST",
    body: JSON.stringify({ documentType: params.documentType, originalFileName: params.file.name, mimeType: params.file.type || "application/octet-stream", fileSize: params.file.size }),
  });
  if (!presign.ok) throw new Error(`Could not start upload (${presign.status}).`);
  const { uploadUrl, storageReference } = await presign.json();

  const put = await fetch(uploadUrl, { method: "PUT", body: params.file, headers: { "Content-Type": params.file.type || "application/octet-stream" } });
  if (!put.ok) throw new Error("Upload to storage failed.");

  const finalize = await authFetch("/api/carriers/documents", {
    method: "PATCH",
    body: JSON.stringify({ documentType: params.documentType, storageReference, originalFileName: params.file.name, mimeType: params.file.type || "application/octet-stream", fileSize: params.file.size, expiresAt: params.expiresAt }),
  });
  if (!finalize.ok) throw new Error(`Could not finalize upload (${finalize.status}).`);
  const data = await finalize.json();
  return data.document;
}

export async function getDocumentDownloadUrl(documentId: string): Promise<string> {
  const res = await authFetch(`/api/carriers/documents?documentId=${encodeURIComponent(documentId)}`);
  if (!res.ok) throw new Error(`Could not get download link (${res.status}).`);
  const data = await res.json();
  return data.downloadUrl;
}

export async function getFactoring(): Promise<{ profile: FactoringProfile; activeAssignment: PaymentAssignment }> {
  const res = await authFetch("/api/carriers/factoring");
  if (res.status === 404) return { profile: null, activeAssignment: null };
  if (!res.ok) throw new Error(`Could not load factoring (${res.status}).`);
  return res.json();
}

/** Derive a document's display state from its record + today. */
export function documentState(doc: CarrierDocument | undefined, now = new Date()): DocumentState {
  if (!doc) return "MISSING";
  if (doc.supersededById || doc.supersededAt) return "SUPERSEDED";
  if (doc.rejectionReason) return "REJECTED";
  if (doc.expiresAt && new Date(doc.expiresAt).getTime() <= now.getTime()) return "EXPIRED";
  return doc.verified ? "APPROVED" : "PENDING_REVIEW";
}

/** Insurance expiration warning tier from server dates (UI never computes
 * eligibility itself — this only picks a banner). */
export type InsuranceWarning = "NONE" | "UPCOMING" | "RENEWAL" | "URGENT" | "EXPIRED";
export function insuranceWarning(expiresAt: string | null, now = new Date()): InsuranceWarning {
  const d = daysUntil(expiresAt, now);
  if (d === null) return "NONE";
  if (d < 0) return "EXPIRED";
  if (d <= 7) return "URGENT";
  if (d <= 14) return "RENEWAL";
  if (d <= 30) return "UPCOMING";
  return "NONE";
}

/** Days until a date (negative if past). */
export function daysUntil(dateIso: string | null, now = new Date()): number | null {
  if (!dateIso) return null;
  return Math.floor((new Date(dateIso).getTime() - now.getTime()) / 86400000);
}

// ---- Gap-contract endpoints (added once the backend contracts existed) ----

export type EligibilityBlocker = { code: string; message: string; action: string };
export type CarrierEligibility = { eligible: boolean; blockers: EligibilityBlocker[] };
export async function getEligibility(): Promise<CarrierEligibility | null> {
  const res = await authFetch("/api/carriers/eligibility");
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Could not load eligibility (${res.status}).`);
  return res.json();
}

export type FmcsaState = "NOT_CHECKED" | "PENDING" | "VERIFIED" | "MISMATCH" | "STALE" | "REVIEW_REQUIRED" | "PROVIDER_UNAVAILABLE";
export type FmcsaStatus = { state: FmcsaState; detail: string | null; checkedAt: string | null };
export async function getFmcsaStatus(): Promise<FmcsaStatus | null> {
  const res = await authFetch("/api/carriers/fmcsa-status");
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Could not load FMCSA status (${res.status}).`);
  return res.json();
}

export const INSURANCE_TYPES = ["AUTO_LIABILITY", "CARGO", "GENERAL_LIABILITY"] as const;
export type InsuranceType = (typeof INSURANCE_TYPES)[number];
export type InsuranceInput = {
  type: InsuranceType; insurerName?: string; policyNumber?: string; coverageCents?: number;
  effectiveAt?: string; expiresAt?: string; documentId?: string;
};
export async function listInsurance(): Promise<InsurancePolicy[]> {
  const res = await authFetch("/api/carriers/insurance");
  if (!res.ok) throw new Error(`Could not load insurance (${res.status}).`);
  return (await res.json()).policies ?? [];
}
export async function saveInsurance(input: InsuranceInput & { id?: string }): Promise<InsurancePolicy> {
  const method = input.id ? "PATCH" : "POST";
  const res = await authFetch("/api/carriers/insurance", { method, body: JSON.stringify(input) });
  if (!res.ok) throw new Error(`Could not save insurance (${res.status}).`);
  return (await res.json()).policy;
}
export async function deleteInsurance(id: string): Promise<void> {
  const res = await authFetch(`/api/carriers/insurance?id=${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Could not delete insurance (${res.status}).`);
}

export type EquipmentInput = { equipmentType: string; year?: number; make?: string; unitNumber?: string; vinLast6?: string; hasLiftgate?: boolean };
export async function listEquipment(): Promise<Equipment[]> {
  const res = await authFetch("/api/carriers/equipment");
  if (!res.ok) throw new Error(`Could not load equipment (${res.status}).`);
  return (await res.json()).equipment ?? [];
}
export async function saveEquipment(input: EquipmentInput & { id?: string }): Promise<Equipment> {
  const method = input.id ? "PATCH" : "POST";
  const res = await authFetch("/api/carriers/equipment", { method, body: JSON.stringify(input) });
  if (!res.ok) throw new Error(`Could not save equipment (${res.status}).`);
  return (await res.json()).equipment;
}
export async function deleteEquipment(id: string): Promise<void> {
  const res = await authFetch(`/api/carriers/equipment?id=${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Could not delete equipment (${res.status}).`);
}

export type LaneInput = { originState?: string; originMetro?: string; destinationState?: string; destinationMetro?: string };
export async function listLanes(): Promise<Lane[]> {
  const res = await authFetch("/api/carriers/lanes");
  if (!res.ok) throw new Error(`Could not load lanes (${res.status}).`);
  return (await res.json()).lanes ?? [];
}
export async function saveLane(input: LaneInput & { id?: string }): Promise<Lane> {
  const method = input.id ? "PATCH" : "POST";
  const res = await authFetch("/api/carriers/lanes", { method, body: JSON.stringify(input) });
  if (!res.ok) throw new Error(`Could not save lane (${res.status}).`);
  return (await res.json()).lane;
}
export async function deleteLane(id: string): Promise<void> {
  const res = await authFetch(`/api/carriers/lanes?id=${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Could not delete lane (${res.status}).`);
}

export async function acknowledgeAgreement(input: { agreementType: string; version?: string; signedByName: string; documentId?: string }): Promise<Agreement> {
  const res = await authFetch("/api/carriers/agreements/acknowledge", { method: "POST", body: JSON.stringify(input) });
  if (!res.ok) throw new Error(`Could not acknowledge agreement (${res.status}).`);
  return (await res.json()).agreement;
}

/** Submit the application. Returns the new status; 428 with missing[] if incomplete. */
export async function submitApplication(): Promise<{ status: string; missing?: string[] }> {
  const res = await authFetch("/api/carriers/application/submit", { method: "POST" });
  if (res.status === 428) { const d = await res.json(); return { status: "INCOMPLETE", missing: d.missing ?? [] }; }
  if (!res.ok) throw new Error(`Could not submit application (${res.status}).`);
  return res.json();
}

export type FactoringDocType = "NOTICE_OF_ASSIGNMENT" | "RELEASE_OF_ASSIGNMENT" | "REMITTANCE_INSTRUCTIONS" | "OTHER";
export async function uploadFactoringDocument(params: { documentType: FactoringDocType; file: File; effectiveAt?: string; expiresAt?: string }): Promise<void> {
  const presign = await authFetch("/api/carriers/factoring/documents", {
    method: "POST",
    body: JSON.stringify({ documentType: params.documentType, originalFileName: params.file.name, mimeType: params.file.type || "application/octet-stream", fileSize: params.file.size }),
  });
  if (!presign.ok) throw new Error(`Could not start upload (${presign.status}).`);
  const { uploadUrl, storageReference } = await presign.json();
  const put = await fetch(uploadUrl, { method: "PUT", body: params.file, headers: { "Content-Type": params.file.type || "application/octet-stream" } });
  if (!put.ok) throw new Error("Upload to storage failed.");
  const finalize = await authFetch("/api/carriers/factoring/documents", {
    method: "PATCH",
    body: JSON.stringify({ documentType: params.documentType, storageReference, originalFileName: params.file.name, effectiveAt: params.effectiveAt, expiresAt: params.expiresAt }),
  });
  if (!finalize.ok) throw new Error(`Could not finalize upload (${finalize.status}).`);
}
