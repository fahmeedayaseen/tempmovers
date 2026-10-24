/**
 * Freight load lifecycle + financial model (freight phase), PURE and testable.
 * Everything here is dormant behind the brokerage flags — this is decision
 * logic the (gated) routes call, not an enabled workflow.
 */

export type LoadStatus =
  | "DRAFT" | "QUOTE_REQUESTED" | "QUOTED" | "BOOKED" | "AVAILABLE" | "OFFERED"
  | "ACCEPTED" | "DISPATCHED" | "AT_PICKUP" | "LOADED" | "IN_TRANSIT"
  | "AT_DELIVERY" | "DELIVERED" | "POD_PENDING" | "COMPLETED" | "INVOICED"
  | "PAID" | "CANCELED" | "EXCEPTION";

/**
 * Allowed forward transitions. CANCELED and EXCEPTION are reachable from most
 * operational states (handled separately). The happy path is a strict sequence
 * so invalid jumps (e.g. DRAFT -> DELIVERED) are rejected server-side.
 */
const FORWARD: Record<LoadStatus, LoadStatus[]> = {
  DRAFT: ["QUOTE_REQUESTED", "BOOKED"],
  QUOTE_REQUESTED: ["QUOTED"],
  QUOTED: ["BOOKED"],
  BOOKED: ["AVAILABLE"],
  AVAILABLE: ["OFFERED"],
  OFFERED: ["ACCEPTED", "AVAILABLE"], // back to AVAILABLE if all offers decline/expire
  ACCEPTED: ["DISPATCHED"],
  DISPATCHED: ["AT_PICKUP"],
  AT_PICKUP: ["LOADED"],
  LOADED: ["IN_TRANSIT"],
  IN_TRANSIT: ["AT_DELIVERY"],
  AT_DELIVERY: ["DELIVERED"],
  DELIVERED: ["POD_PENDING"],
  POD_PENDING: ["COMPLETED"],
  COMPLETED: ["INVOICED"],
  INVOICED: ["PAID"],
  PAID: [],
  CANCELED: [],
  EXCEPTION: [], // resolved via explicit admin action back to a prior state
};

// States from which a load may still be canceled.
const CANCELABLE: LoadStatus[] = ["DRAFT", "QUOTE_REQUESTED", "QUOTED", "BOOKED", "AVAILABLE", "OFFERED", "ACCEPTED", "DISPATCHED"];
// States that can be flagged as an exception.
const EXCEPTIONABLE: LoadStatus[] = ["ACCEPTED", "DISPATCHED", "AT_PICKUP", "LOADED", "IN_TRANSIT", "AT_DELIVERY", "DELIVERED", "POD_PENDING", "INVOICED"];

export function canTransitionLoad(from: LoadStatus, to: LoadStatus): boolean {
  if (from === to) return false;
  if (to === "CANCELED") return CANCELABLE.includes(from);
  if (to === "EXCEPTION") return EXCEPTIONABLE.includes(from);
  return (FORWARD[from] ?? []).includes(to);
}

export function assertLoadTransition(from: LoadStatus, to: LoadStatus): void {
  if (!canTransitionLoad(from, to)) throw new Error(`Illegal load status transition: ${from} -> ${to}`);
}

/** A load is assignable to a carrier only while AVAILABLE or OFFERED. */
export function isAssignable(status: LoadStatus): boolean {
  return status === "AVAILABLE" || status === "OFFERED";
}

// ---- Financial model (integer cents only) ----

export type LoadFinancials = {
  customerLinehaulCents: number;
  customerFuelSurchargeCents: number;
  customerAccessorialsCents: number;
  carrierLinehaulCents: number;
  carrierFuelSurchargeCents: number;
  carrierAccessorialsCents: number;
  processingFeesCents: number;
};

export type ComputedFinancials = LoadFinancials & {
  customerTotalCents: number;
  carrierTotalCents: number;
  grossMarginCents: number;
  platformRevenueCents: number;
};

function assertInt(n: number, label: string) {
  if (!Number.isInteger(n)) throw new Error(`${label} must be an integer number of cents, got ${n}`);
}

/**
 * Compute totals, margin, and platform revenue — all in integer cents, never
 * from floating-point dollars. Margin = customer total - carrier total;
 * platform revenue = margin - processing fees.
 */
export function computeLoadFinancials(f: LoadFinancials): ComputedFinancials {
  for (const [k, v] of Object.entries(f)) assertInt(v, k);

  const customerTotalCents = f.customerLinehaulCents + f.customerFuelSurchargeCents + f.customerAccessorialsCents;
  const carrierTotalCents = f.carrierLinehaulCents + f.carrierFuelSurchargeCents + f.carrierAccessorialsCents;
  const grossMarginCents = customerTotalCents - carrierTotalCents;
  const platformRevenueCents = grossMarginCents - f.processingFeesCents;

  return { ...f, customerTotalCents, carrierTotalCents, grossMarginCents, platformRevenueCents };
}

/** Basis points of margin against customer total (for the 15-18% target check). */
export function marginBasisPoints(c: ComputedFinancials): number {
  if (c.customerTotalCents <= 0) return 0;
  return Math.round((c.grossMarginCents * 10000) / c.customerTotalCents);
}
