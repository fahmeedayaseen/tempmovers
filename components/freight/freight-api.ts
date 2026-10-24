"use client";

import { authFetch } from "@/lib/client-auth";

/** Freight Operations Console API client. Binds to the real freight contracts.
 * Money stays integer cents from the server; the UI only formats. */

export type LoadStatus =
  | "DRAFT" | "QUOTE_REQUESTED" | "QUOTED" | "BOOKED" | "AVAILABLE" | "OFFERED" | "ACCEPTED"
  | "DISPATCHED" | "AT_PICKUP" | "LOADED" | "IN_TRANSIT" | "AT_DELIVERY" | "DELIVERED"
  | "POD_PENDING" | "COMPLETED" | "INVOICED" | "PAID" | "CANCELED" | "EXCEPTION";

/** Mirror of the backend FORWARD map — used ONLY to decide which action buttons
 * to show. The backend remains the source of truth (it re-validates and returns
 * a reason on failure); this just avoids showing actions the backend will reject. */
const FORWARD: Record<LoadStatus, LoadStatus[]> = {
  DRAFT: ["QUOTE_REQUESTED", "BOOKED"], QUOTE_REQUESTED: ["QUOTED"], QUOTED: ["BOOKED"],
  BOOKED: ["AVAILABLE"], AVAILABLE: ["OFFERED"], OFFERED: ["ACCEPTED", "AVAILABLE"],
  ACCEPTED: ["DISPATCHED"], DISPATCHED: ["AT_PICKUP"], AT_PICKUP: ["LOADED"], LOADED: ["IN_TRANSIT"],
  IN_TRANSIT: ["AT_DELIVERY"], AT_DELIVERY: ["DELIVERED"], DELIVERED: ["POD_PENDING"],
  POD_PENDING: ["COMPLETED"], COMPLETED: ["INVOICED"], INVOICED: ["PAID"], PAID: [], CANCELED: [], EXCEPTION: [],
};
const CANCELABLE: LoadStatus[] = ["DRAFT", "QUOTE_REQUESTED", "QUOTED", "BOOKED", "AVAILABLE", "OFFERED", "ACCEPTED", "DISPATCHED"];
const EXCEPTIONABLE: LoadStatus[] = ["ACCEPTED", "DISPATCHED", "AT_PICKUP", "LOADED", "IN_TRANSIT", "AT_DELIVERY", "DELIVERED", "POD_PENDING", "INVOICED"];

export function allowedTransitions(from: LoadStatus): LoadStatus[] {
  const out = [...(FORWARD[from] ?? [])];
  if (CANCELABLE.includes(from)) out.push("CANCELED");
  if (EXCEPTIONABLE.includes(from)) out.push("EXCEPTION");
  return out;
}

export function dollars(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "Not tracked";
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
}

export type LoadListRow = {
  id: string; status: LoadStatus; marketId: string | null; assignedCarrierId: string | null;
  commodity: string | null; equipmentType: string | null; weightLbs: number | null;
  customerTotalCents: number; carrierTotalCents: number; grossMarginCents: number; platformRevenueCents: number;
  createdAt: string; updatedAt: string;
  _count: { offers: number; rateConfirmations: number; invoices: number; settlements: number };
};

export type FreightDashboard = {
  brokerageActive: boolean;
  statusCounts: Record<string, number>;
  attention: { offersAwaitingResponse: number; loadsMissingRateConfirmation: number; podsAwaitingApproval: number; accessorialsAwaitingReview: number; loadsInException: number };
  financials: { grossMarginCents: number; platformRevenueCents: number; customerTotalCents: number };
};

export type LoadDetail = {
  load: LoadListRow & {
    version: number; shipperUserId: string | null; palletCount: number | null; loadRequirements: string | null;
    customerLinehaulCents: number; customerFuelSurchargeCents: number; customerAccessorialsCents: number;
    carrierLinehaulCents: number; carrierFuelSurchargeCents: number; carrierAccessorialsCents: number; processingFeesCents: number;
    stops: { id: string; sequence: number; stopType: string; city: string | null; state: string | null; zip: string | null; appointmentAt: string | null }[];
    offers: { id: string; carrierId: string; offeredRateCents: number; status: string; expiresAt: string; declineReason: string | null; createdAt: string }[];
    rateConfirmations: { id: string; version: number; carrierId: string; agreedCarrierRateCents: number; acceptedAt: string | null; generatedAt: string }[];
    accessorials: { id: string; kind: string; requestedAmountCents: number; approvedAmountCents: number | null; approvalStatus: string; supportingDocumentId: string | null; customerBillable: boolean; carrierPayable: boolean; reason: string | null }[];
    invoices: { id: string; invoiceNumber: string; totalCents: number; status: string; dueDate: string | null }[];
    settlements: { id: string; finalAmountCents: number; status: string; remitToName: string | null }[];
    amendments: { id: string; version: number; customerTotalCents: number; carrierTotalCents: number; reason: string | null }[];
    auditEvents: { id: string; event: string; detail: unknown; actorId: string | null; createdAt: string }[];
  };
  activeAssignment: { id: string; remitToName: string; status: string } | null;
  brokerageActive: boolean;
};

export async function getFreightDashboard(): Promise<FreightDashboard> {
  const res = await authFetch("/api/freight/dashboard");
  if (!res.ok) throw new Error(`Could not load dashboard (${res.status}).`);
  return res.json();
}

export async function listLoads(filters: Record<string, string> = {}): Promise<{ loads: LoadListRow[]; brokerageActive: boolean }> {
  const qs = new URLSearchParams(filters).toString();
  const res = await authFetch(`/api/freight/loads/list${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error(`Could not load loads (${res.status}).`);
  return res.json();
}

export async function getLoadDetail(loadId: string): Promise<LoadDetail> {
  const res = await authFetch(`/api/freight/loads/${loadId}`);
  if (!res.ok) throw new Error(`Could not load load (${res.status}).`);
  return res.json();
}

/** Transition a load. Surfaces the backend's reason + current status on failure
 * rather than forcing the UI forward. */
export async function transitionLoad(loadId: string, toStatus: LoadStatus, reason?: string): Promise<{ ok: boolean; error?: string; code?: string }> {
  const res = await authFetch("/api/freight/loads", { method: "PATCH", body: JSON.stringify({ loadId, toStatus, reason }) });
  if (res.ok) return { ok: true };
  const d = await res.json().catch(() => ({}));
  // 403 = brokerage/gate disabled; 409 = illegal transition. Return the message.
  return { ok: false, error: d.error || `Action failed (${res.status}).`, code: res.status === 403 ? "DISABLED" : res.status === 409 ? "ILLEGAL" : "ERROR" };
}

export async function getLoadAudit(loadId: string): Promise<{ events: { id: string; event: string; detail: unknown; actorId: string | null; createdAt: string }[] }> {
  const res = await authFetch(`/api/freight/loads/audit?loadId=${encodeURIComponent(loadId)}`);
  if (!res.ok) throw new Error(`Could not load audit (${res.status}).`);
  return res.json();
}
