"use client";

import { authFetch } from "@/lib/client-auth";

/** Admin carrier-review API client. Mirrors the admin carrier contracts. */

export type AdminCarrierListRow = {
  id: string; legalBusinessName: string; dotNumber: string | null; mcNumber: string | null;
  status: string; marketId: string | null;
  insurancePolicies: { type: string; expiresAt: string | null }[];
  fmcsaChecks: { authorized: boolean | null; checkError: string | null; checkedAt: string }[];
};

export type AdminCarrierDocument = {
  id: string; type: string; fileName: string | null; verified: boolean; expiresAt: string | null;
  rejectionReason: string | null; supersededById: string | null; supersededAt: string | null; createdAt: string;
};

export type AdminCarrierDetail = {
  carrier: {
    id: string; legalBusinessName: string; dbaName: string | null; ein: string | null;
    dotNumber: string | null; mcNumber: string | null; homeTerminal: string | null;
    operatingRadiusMiles: number | null; numberOfTrucks: number | null; status: string; marketId: string | null;
    documents: AdminCarrierDocument[];
    insurancePolicies: { id: string; type: string; insurerName: string | null; policyNumber: string | null; coverageCents: number | null; effectiveAt: string | null; expiresAt: string | null }[];
    equipment: { id: string; equipmentType: string; make: string | null; unitNumber: string | null; hasLiftgate: boolean }[];
    lanes: { id: string; originState: string | null; originMetro: string | null; destinationState: string | null; destinationMetro: string | null }[];
    agreements: { id: string; agreementType: string; active: boolean; signedAt: string | null; signedByName: string | null }[];
    fmcsaChecks: { authorized: boolean | null; checkError: string | null; checkedAt: string; operatingStatus: string | null }[];
    statusEvents: { id: string; fromStatus: string | null; toStatus: string; reason: string | null; createdAt: string }[];
    notes: { id: string; body: string; authorId: string; createdAt: string }[];
  };
  factoringProfile: { usesFactoring: boolean; factoringCompanyName: string | null; verificationStatus: string } | null;
  activeAssignment: { id: string; remitToName: string; status: string } | null;
};

export async function listCarriers(status?: string): Promise<AdminCarrierListRow[]> {
  const url = status ? `/api/admin/carriers?status=${encodeURIComponent(status)}` : "/api/admin/carriers";
  const res = await authFetch(url);
  if (!res.ok) throw new Error(`Could not load carriers (${res.status}).`);
  return (await res.json()).carriers ?? [];
}

export async function getCarrierDetail(carrierId: string): Promise<AdminCarrierDetail> {
  const res = await authFetch(`/api/admin/carriers/${carrierId}`);
  if (!res.ok) throw new Error(`Could not load carrier (${res.status}).`);
  return res.json();
}

/** Status transition. Returns {ok} or throws with a readable message; 409 for
 * illegal transition, 428 for activation blocked by insurance. */
export async function transitionCarrier(carrierId: string, toStatus: string, reason?: string): Promise<void> {
  const res = await authFetch("/api/admin/carriers", { method: "PATCH", body: JSON.stringify({ carrierId, toStatus, reason }) });
  if (res.status === 409) throw new Error("That status change isn't allowed from the carrier's current status.");
  if (res.status === 428) {
    const d = await res.json();
    throw new Error(`Cannot activate: ${(d.reasons ?? []).join(", ") || "requirements not met."}`);
  }
  if (!res.ok) throw new Error(`Status change failed (${res.status}).`);
}

export async function reviewDocument(carrierId: string, documentId: string, decision: "APPROVE" | "REJECT" | "SUPERSEDE", reason?: string, supersededById?: string): Promise<void> {
  const res = await authFetch(`/api/admin/carriers/${carrierId}/documents`, { method: "PATCH", body: JSON.stringify({ documentId, decision, reason, supersededById }) });
  if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d?.error || `Document review failed (${res.status}).`); }
}

export async function refreshFmcsa(carrierId: string): Promise<void> {
  const res = await authFetch(`/api/admin/carriers/${carrierId}/refresh-fmcsa`, { method: "POST" });
  if (!res.ok) throw new Error(`FMCSA re-check failed (${res.status}).`);
}

export async function addNote(carrierId: string, body: string): Promise<void> {
  const res = await authFetch(`/api/admin/carriers/${carrierId}/notes`, { method: "POST", body: JSON.stringify({ body }) });
  if (!res.ok) throw new Error(`Could not add note (${res.status}).`);
}

export async function reviewFactoring(carrierId: string, decision: "VERIFIED" | "REJECTED" | "EXPIRED", reason?: string): Promise<void> {
  const res = await authFetch("/api/admin/carriers/factoring", { method: "PATCH", body: JSON.stringify({ carrierId, decision, reason }) });
  if (!res.ok) throw new Error(`Factoring review failed (${res.status}).`);
}

export async function getAdminEligibility(carrierId: string): Promise<{ eligible: boolean; blockers: { code: string; message: string }[] }> {
  const res = await authFetch(`/api/admin/carriers/eligibility?carrierId=${encodeURIComponent(carrierId)}`);
  if (!res.ok) throw new Error(`Could not load eligibility (${res.status}).`);
  return res.json();
}
