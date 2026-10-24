/**
 * The canonical "safe to show a non-assigned worker" field list for a
 * freight load. Extracted from what was already independently duplicated
 * (and, worth noting, already correctly matched) across
 * app/api/loads/route.ts (PUBLIC_LOAD_SELECT) and
 * app/api/driver/loads/route.ts (AUTHED_LOAD_SELECT) — both should import
 * this instead of maintaining their own copy, so a future field addition
 * to CarrierRoute can't accidentally leak through one list but not the
 * other.
 *
 * Deliberately excludes: exact pickup/delivery address, shipper/receiver
 * contact info, access/gate codes, commodity description, bill of lading,
 * declared value, internal notes, and any other worker's information.
 */
export const SANITIZED_LOAD_SELECT = {
  id: true, title: true, visibility: true, status: true,
  originCity: true, originState: true, originZip: true,
  destinationCity: true, destinationState: true,
  equipmentType: true, pickupDate: true, estimatedHoursOrMiles: true,
  stopCount: true, liftgateRequired: true, cdlRequired: true, isLocalRoute: true,
  grossCarrierCents: true,
} as const;

/**
 * The full-detail field list for a load once a driver is actually
 * assigned to it — everything in SANITIZED_LOAD_SELECT, plus the
 * previously-hidden private fields. Used by both
 * POST /api/loads/[loadId]/request (the moment of assignment) and
 * GET /api/driver/assigned-loads (viewing it again later), so the two
 * can't drift apart the same way SANITIZED_LOAD_SELECT was built to
 * keep the public/authenticated board listings from drifting.
 *
 * Before this existed, the request route's own assignment response
 * only returned a hand-picked subset of private fields plus id/status/
 * city/state — missing title, pickup date, equipment type, payout
 * amount, and every other base field a driver would actually want to
 * see immediately upon being assigned a load.
 */
export const FULL_ASSIGNED_LOAD_SELECT = {
  ...SANITIZED_LOAD_SELECT,
  exactPickupAddress: true, exactDeliveryAddress: true,
  shipperContactName: true, shipperContactPhone: true,
  accessCode: true, commodityDescription: true,
} as const;
