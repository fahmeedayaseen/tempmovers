/**
 * Typed service interfaces for future integrations (future-development
 * extension points). These are CONTRACTS ONLY — there are no implementations,
 * no wiring, and nothing here is called by production code. They exist so
 * that when each feature is fully specified, an implementation can be dropped
 * in behind its feature flag without reshaping call sites.
 *
 * DO NOT implement or invoke these from booking/payment/settlement/
 * reconciliation. Each corresponds to a FUTURE_FEATURE_KEY and stays dormant
 * until its flag is enabled AND a real implementation is provided.
 *
 * Types are intentionally minimal and marked with `unknown`-friendly shapes
 * where the real contract isn't specified yet — a deliberate signal that the
 * shape is provisional, not a hidden assumption about the future feature.
 */

/** AI_DISPATCH — recommend worker/carrier assignments for a booking. */
export interface AiDispatchService {
  readonly featureKey: "AI_DISPATCH";
  recommendAssignment(input: { bookingId: string; candidates: string[] }): Promise<{ recommended: string[]; rationale?: string }>;
}

/** ROUTE_OPTIMIZATION — order stops / plan routes for multi-stop work. */
export interface RouteOptimizationService {
  readonly featureKey: "ROUTE_OPTIMIZATION";
  optimize(input: { stops: { id: string; lat: number; lng: number }[] }): Promise<{ orderedStopIds: string[]; totalMeters?: number }>;
}

/** PHOTO_ESTIMATES — estimate job size/hours from photos. */
export interface PhotoEstimationService {
  readonly featureKey: "PHOTO_ESTIMATES";
  estimateFromPhotos(input: { photoUrls: string[] }): Promise<{ estimatedHours?: number; estimatedMovers?: number; confidence?: number }>;
}

/** BACKGROUND_CHECKS — provider screening via an external vendor. */
export interface BackgroundCheckService {
  readonly featureKey: "BACKGROUND_CHECKS";
  initiateCheck(input: { userId: string }): Promise<{ externalCheckId: string; status: "pending" }>;
  getStatus(externalCheckId: string): Promise<{ status: "pending" | "clear" | "consider" | "failed" }>;
}

/** INSURANCE_VERIFICATION — verify a carrier's insurance certificate. */
export interface InsuranceVerificationService {
  readonly featureKey: "INSURANCE_VERIFICATION";
  verify(input: { carrierId: string; policyNumber?: string }): Promise<{ verified: boolean; expiresAt?: string }>;
}

/** FREIGHT_BOARD_INTEGRATION — pull/push loads from external freight boards. */
export interface FreightBoardService {
  readonly featureKey: "FREIGHT_BOARD_INTEGRATION";
  searchLoads(input: { origin?: string; destination?: string }): Promise<{ externalLoadIds: string[] }>;
  importLoad(externalLoadId: string): Promise<{ imported: boolean; loadId?: string }>;
}

/**
 * Registry type mapping each future feature key to its service contract.
 * There is deliberately NO concrete instance of this — resolving a service
 * before it's implemented should be a compile-time and runtime no-op.
 */
export interface FutureServiceRegistry {
  AI_DISPATCH?: AiDispatchService;
  ROUTE_OPTIMIZATION?: RouteOptimizationService;
  PHOTO_ESTIMATES?: PhotoEstimationService;
  BACKGROUND_CHECKS?: BackgroundCheckService;
  INSURANCE_VERIFICATION?: InsuranceVerificationService;
  FREIGHT_BOARD_INTEGRATION?: FreightBoardService;
}
