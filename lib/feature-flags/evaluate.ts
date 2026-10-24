/**
 * Feature-flag framework — PURE gate evaluation (future-development extension
 * points). Decides whether a feature is ON for a given request context. No DB
 * here, so the targeting rules are fully unit-testable.
 *
 * SAFETY: this gate is advisory and OFF by default. It NEVER touches booking,
 * payment, settlement, or reconciliation logic — callers opt in by checking
 * isFeatureEnabled() before exposing a future feature. Every future feature
 * ships DISABLED; turning one on is a deliberate admin action.
 *
 * Evaluation:
 *   - status DISABLED  -> always OFF (hard kill switch, ignores targeting).
 *   - status ENABLED   -> ON where targeting matches; naked targeting
 *                         (all lists empty) means ON everywhere.
 *   - status PILOT     -> ON only when the request matches a configured
 *                         pilot group (and any other set targeting).
 * A dimension with an empty list is "unrestricted" on that axis. A dimension
 * with entries requires the request's value to be a member. PILOT
 * additionally requires a non-empty pilotGroups match.
 */
import type { UserRole } from "@prisma/client";

export type FeatureFlagConfig = {
  key: string;
  enabled: boolean; // legacy master switch, retained for back-compat
  status: "DISABLED" | "PILOT" | "ENABLED";
  enabledEnvironments: string[];
  enabledMarkets: string[];
  enabledRoles: UserRole[];
  enabledServiceTypes: string[];
  enabledPilotGroups: string[];
};

export type FeatureContext = {
  environment?: string;
  marketId?: string | null;
  role?: UserRole | null;
  serviceType?: string | null;
  pilotGroups?: string[]; // cohorts this request/user belongs to
};

function matchesList(list: string[], value: string | null | undefined): boolean {
  if (list.length === 0) return true; // unrestricted on this axis
  if (value == null) return false; // restricted but no value to match
  return list.includes(value);
}

export function evaluateFlag(flag: FeatureFlagConfig, ctx: FeatureContext): boolean {
  // Hard off: either the master switch is off or status is DISABLED.
  if (!flag.enabled) return false;
  if (flag.status === "DISABLED") return false;

  // Targeting axes (empty list = unrestricted).
  if (!matchesList(flag.enabledEnvironments, ctx.environment)) return false;
  if (!matchesList(flag.enabledMarkets, ctx.marketId ?? undefined)) return false;
  if (!matchesList(flag.enabledServiceTypes, ctx.serviceType ?? undefined)) return false;
  if (flag.enabledRoles.length > 0) {
    if (!ctx.role || !flag.enabledRoles.includes(ctx.role)) return false;
  }

  if (flag.status === "PILOT") {
    // PILOT requires an explicit pilot-group match.
    if (flag.enabledPilotGroups.length === 0) return false;
    const groups = ctx.pilotGroups ?? [];
    if (!flag.enabledPilotGroups.some(g => groups.includes(g))) return false;
    return true;
  }

  // status ENABLED and all set targeting matched.
  return true;
}

/** The canonical registry of future features — all ship DISABLED. */
export const FUTURE_FEATURE_KEYS = [
  "AI_DISPATCH",
  "PHOTO_ESTIMATES",
  "ROUTE_OPTIMIZATION",
  "RECURRING_CONTRACTS",
  "ENTERPRISE_CREWS",
  "MULTI_STOP_ROUTING",
  "BACKGROUND_CHECKS",
  "INSURANCE_VERIFICATION",
  "FREIGHT_BOARD_INTEGRATION",
  // Freight expansion & ELD roadmap (all OFF; live automation is post-launch).
  // At Indianapolis launch, freight runs on the internal board + manual import
  // — none of these need to be enabled.
  "FREIGHT_BOARD_SYNC_DAT",
  "FREIGHT_BOARD_SYNC_TRUCKSTOP",
  "FREIGHT_BOARD_SYNC_123LOADBOARD",
  "FMCSA_VERIFICATION",
  "IDENTITY_VERIFICATION",
  "ELD_INTEGRATION",
  "GPS_TELEMATICS",
  // Freight org roadmap: dispatcher (launch) → agent (phase 2) → broker
  // (phase 3, stays disabled until authority + workflows exist).
  "FREIGHT_AGENT_MODULE",
  "FREIGHT_BROKER_MODULE",
  // Brokerage OPERATIONS flags (launch spec) — granular toggles under the
  // brokerage umbrella. All OFF until broker authority + bond + insurance +
  // agreements are confirmed active by management. FREIGHT_BROKERAGE_ENABLED is
  // the master switch; the rest gate individual brokerage capabilities so they
  // can be turned on incrementally AFTER authority is live.
  "FREIGHT_BROKERAGE_ENABLED",
  "LOAD_POSTING_ENABLED",
  "CARRIER_LOAD_ACCEPTANCE_ENABLED",
  "DISPATCH_SERVICES_ENABLED",
  "DIRECT_SHIPPER_QUOTING_ENABLED",
  "CARRIER_PAYMENTS_ENABLED",
  "BROKER_CARRIER_AGREEMENTS_ENABLED",
  "RATE_CONFIRMATION_GENERATION_ENABLED",
  // Factoring referral marketplace — dormant until partner agreements are
  // signed. Referral requests + any external submission stay disabled.
  "FACTORING_REFERRAL_ENABLED",
] as const;

export type FutureFeatureKey = (typeof FUTURE_FEATURE_KEYS)[number];
