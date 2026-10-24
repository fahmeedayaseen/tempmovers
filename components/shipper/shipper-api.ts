"use client";

import { authFetch } from "@/lib/client-auth";

/** Shipper Portal API client. Every response is shipper-safe: customer
 * transportation price only, never carrier pay or margin. */

export type ShipperStatus = "REQUESTED" | "QUOTED" | "BOOKED" | "SCHEDULED" | "IN_TRANSIT" | "DELIVERED" | "COMPLETED" | "INVOICED" | "PAID" | "EXCEPTION";

export type ShipperLoadRow = {
  id: string; shipperStatus: ShipperStatus; commodity: string | null; equipmentType: string | null;
  weightLbs: number | null; palletCount: number | null; customerTotalCents: number; createdAt: string; updatedAt: string;
};

export type ShipperLoadDetail = {
  load: {
    id: string; shipperStatus: ShipperStatus; commodity: string | null; equipmentType: string | null;
    weightLbs: number | null; palletCount: number | null;
    customerLinehaulCents: number; customerFuelSurchargeCents: number; customerAccessorialsCents: number; customerTotalCents: number;
    stops: { sequence: number; stopType: string; city: string | null; state: string | null; zip: string | null; appointmentAt: string | null }[];
    accessorials: { id: string; kind: string; approvedAmountCents: number | null; approvalStatus: string }[];
    invoices: { id: string; invoiceNumber: string; totalCents: number; status: string; dueDate: string | null }[];
  };
  carrierName: string | null;
  podAvailable: boolean;
};

export type ShipperInvoice = { id: string; invoiceNumber: string; chargesCents: number; accessorialsCents: number; taxCents: number; totalCents: number; paymentTerms: string | null; dueDate: string | null; status: string; createdAt: string; loadId: string };

export type ShipperDashboard = { buckets: Record<string, number>; activeLoads: number; deliveredLoads: number; openInvoices: number };

export function dollars(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "—";
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
}

export async function getShipperDashboard(): Promise<ShipperDashboard> {
  const res = await authFetch("/api/shipper/dashboard");
  if (!res.ok) throw new Error(`Could not load dashboard (${res.status}).`);
  return res.json();
}
export async function getShipperLoads(): Promise<ShipperLoadRow[]> {
  const res = await authFetch("/api/shipper/loads");
  if (!res.ok) throw new Error(`Could not load shipments (${res.status}).`);
  return (await res.json()).loads ?? [];
}
export async function getShipperLoad(loadId: string): Promise<ShipperLoadDetail> {
  const res = await authFetch(`/api/shipper/loads/${loadId}`);
  if (!res.ok) throw new Error(`Could not load shipment (${res.status}).`);
  return res.json();
}
export async function getShipperInvoices(): Promise<ShipperInvoice[]> {
  const res = await authFetch("/api/shipper/invoices");
  if (!res.ok) throw new Error(`Could not load invoices (${res.status}).`);
  return (await res.json()).invoices ?? [];
}
export async function submitQuoteRequest(input: Record<string, unknown>): Promise<{ binding: boolean; status: string; message: string }> {
  const res = await authFetch("/api/shipper/quote-request", { method: "POST", body: JSON.stringify(input) });
  if (!res.ok) throw new Error(`Could not submit request (${res.status}).`);
  return res.json();
}
