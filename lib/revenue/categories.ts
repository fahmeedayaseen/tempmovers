/**
 * Revenue category taxonomy (extension point — inert). Defines the revenue
 * types TempMovers earns, so a future revenue ledger and reporting can
 * categorize every dollar consistently. Declaring the taxonomy now (as a
 * const + type, NOT a table) lets reporting code and a later
 * RevenueLedgerEntry model share one vocabulary without adding a
 * money-moving table to the pre-launch migration surface.
 *
 * Nothing writes a ledger yet — this is the category list the ledger will use
 * when it's built (post-Indianapolis-validation, per the revenue-model
 * handoff). Freight-agent commission and broker margin are included so the
 * schema is ready, but their modules stay behind disabled feature flags
 * (FREIGHT_AGENT_MODULE / FREIGHT_BROKER_MODULE) until authority + workflows
 * exist.
 */
export const REVENUE_CATEGORIES = [
  // Core marketplace fees (live at launch).
  "MOVING_PLATFORM_FEE",
  "BOX_TRUCK_PLATFORM_FEE",
  "SEMI_PLATFORM_FEE",
  "JUNK_REMOVAL_TAKE",         // Junk removal — VASRUE Digital Media, 28 Oct 2026: the take-rate inside a junk price.
  "BOOKING_PROTECTION_FEE",
  "ACCESSORIAL_PLATFORM_SHARE",
  "DETENTION_PLATFORM_SHARE",
  // Subscriptions.
  "MOVER_SUBSCRIPTION",
  "DRIVER_SUBSCRIPTION",
  "FLEET_SUBSCRIPTION",
  // Dispatcher (launch) and later freight org tiers (flag-gated).
  "DISPATCHER_SERVICE_FEE",
  "FREIGHT_AGENT_COMMISSION", // phase 2, flag-gated
  "FREIGHT_BROKER_MARGIN",    // phase 3, flag-gated, requires authority
  // Adjustments.
  "REFUND",                   // negative revenue
  "ADJUSTMENT",
] as const;

export type RevenueCategory = (typeof REVENUE_CATEGORIES)[number];

/** Categories that are only valid while their feature flag is enabled. */
export const FLAG_GATED_REVENUE_CATEGORIES: Partial<Record<RevenueCategory, string>> = {
  FREIGHT_AGENT_COMMISSION: "FREIGHT_AGENT_MODULE",
  FREIGHT_BROKER_MARGIN: "FREIGHT_BROKER_MODULE",
};
