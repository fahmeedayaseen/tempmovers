"use client";

import { authFetch } from "@/lib/client-auth";

/** Dispatcher Portal API client. Every carrier/load call is authorized
 * server-side against the dispatcher's per-carrier grants. */

export type DispatcherPermission = "VIEW_LOADS" | "RESPOND_TO_OFFERS" | "UPDATE_LOAD_STATUS" | "UPLOAD_DOCUMENTS" | "VIEW_SETTLEMENT_STATUS" | "MANAGE_DRIVERS" | "VIEW_CARRIER_PROFILE";

export type AssignedCarrier = {
  id: string; legalBusinessName: string; dotNumber: string | null; mcNumber: string | null;
  status: string; homeTerminal: string | null; permissions: DispatcherPermission[]; accessExpiresAt: string | null;
};

export type DispatcherDashboard = {
  carriers: number; activeInTransit: number; missingPod: number; todaysStops: number;
  insuranceWarnings: number; statusCounts: Record<string, number>;
};

export type DispatcherLoadRow = {
  id: string; status: string; commodity: string | null; equipmentType: string | null; weightLbs: number | null;
  carrierTotalCents: number; createdAt: string; updatedAt: string;
  stops: { sequence: number; stopType: string; city: string | null; state: string | null; appointmentAt: string | null }[];
};

export type DispatcherLoadDetail = {
  load: DispatcherLoadRow & {
    palletCount: number | null; assignedCarrierId: string; marketId: string | null;
    offers: { id: string; carrierId: string; offeredRateCents: number; status: string; expiresAt: string; declineReason: string | null }[];
    rateConfirmations: { id: string; version: number; agreedCarrierRateCents: number; acceptedAt: string | null }[];
    settlements: { id: string; status: string }[];
  };
  brokerageActive: boolean;
};

export function dollars(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "Not tracked";
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
}

export async function getAssignedCarriers(): Promise<AssignedCarrier[]> {
  const res = await authFetch("/api/dispatcher/carriers");
  if (!res.ok) throw new Error(`Could not load carriers (${res.status}).`);
  return (await res.json()).carriers ?? [];
}

export async function getDispatcherDashboard(): Promise<DispatcherDashboard> {
  const res = await authFetch("/api/dispatcher/dashboard");
  if (!res.ok) throw new Error(`Could not load dashboard (${res.status}).`);
  return res.json();
}

export async function getCarrierLoads(carrierId: string): Promise<{ loads: DispatcherLoadRow[]; brokerageActive: boolean }> {
  const res = await authFetch(`/api/dispatcher/carriers/${carrierId}/loads`);
  if (res.status === 403) throw new Error("You don't have access to this carrier's loads.");
  if (!res.ok) throw new Error(`Could not load loads (${res.status}).`);
  return res.json();
}

export async function getDispatcherLoad(loadId: string): Promise<DispatcherLoadDetail> {
  const res = await authFetch(`/api/dispatcher/loads/${loadId}`);
  if (!res.ok) throw new Error(`Could not load load (${res.status}).`);
  return res.json();
}

/** Update a load milestone. Dual-gated server-side (permission + brokerage).
 * Surfaces the backend reason on failure rather than forcing the UI forward. */
export async function updateLoadStatus(loadId: string, toStatus: string, reason?: string): Promise<{ ok: boolean; error?: string; code?: string; currentStatus?: string }> {
  const res = await authFetch(`/api/dispatcher/loads/${loadId}/status`, { method: "PATCH", body: JSON.stringify({ toStatus, reason }) });
  if (res.ok) return { ok: true };
  const d = await res.json().catch(() => ({}));
  return { ok: false, error: d.error || `Action failed (${res.status}).`, code: res.status === 403 ? "DENIED" : res.status === 409 ? "ILLEGAL" : "ERROR", currentStatus: d.currentStatus };
}
