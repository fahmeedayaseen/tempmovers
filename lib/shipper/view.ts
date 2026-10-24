/**
 * Shipper-safe view helpers. The single source of truth for what a shipper may
 * see. Pricing privacy is the core rule: a shipper sees ONLY the customer
 * (transportation) price — never carrier pay, margin, platform revenue, or fees.
 *
 * These select maps are used by every shipper read route so no forbidden field
 * can leak. There is deliberately no carrier/margin/platform field here.
 */

/** Prisma select for a shipper load row — customer-facing fields only. */
export const SHIPPER_LOAD_SELECT = {
  id: true, status: true, commodity: true, equipmentType: true, weightLbs: true, palletCount: true,
  // Customer (transportation) price only:
  customerLinehaulCents: true, customerFuelSurchargeCents: true, customerAccessorialsCents: true, customerTotalCents: true,
  createdAt: true, updatedAt: true,
} as const;

/** Internal FreightLoadStatus -> shipper-friendly business status. Internal
 * operational states that aren't meaningful to a customer collapse into the
 * nearest business-facing group. */
const STATUS_MAP: Record<string, string> = {
  DRAFT: "REQUESTED", QUOTE_REQUESTED: "REQUESTED",
  QUOTED: "QUOTED",
  BOOKED: "BOOKED", AVAILABLE: "BOOKED", OFFERED: "BOOKED", ACCEPTED: "BOOKED",
  DISPATCHED: "SCHEDULED", AT_PICKUP: "SCHEDULED",
  LOADED: "IN_TRANSIT", IN_TRANSIT: "IN_TRANSIT", AT_DELIVERY: "IN_TRANSIT",
  DELIVERED: "DELIVERED", POD_PENDING: "DELIVERED",
  COMPLETED: "COMPLETED",
  INVOICED: "INVOICED",
  PAID: "PAID",
  CANCELED: "EXCEPTION", EXCEPTION: "EXCEPTION",
};

export type ShipperStatus = "REQUESTED" | "QUOTED" | "BOOKED" | "SCHEDULED" | "IN_TRANSIT" | "DELIVERED" | "COMPLETED" | "INVOICED" | "PAID" | "EXCEPTION";

export function toShipperStatus(internal: string): ShipperStatus {
  return (STATUS_MAP[internal] ?? "REQUESTED") as ShipperStatus;
}

/** Whether the assigned carrier's identity may be shown to the shipper yet.
 * Only once the load is scheduled/in-progress — not during offer shopping. */
export function carrierVisibleToShipper(internal: string): boolean {
  return ["DISPATCHED", "AT_PICKUP", "LOADED", "IN_TRANSIT", "AT_DELIVERY", "DELIVERED", "POD_PENDING", "COMPLETED", "INVOICED", "PAID"].includes(internal);
}
