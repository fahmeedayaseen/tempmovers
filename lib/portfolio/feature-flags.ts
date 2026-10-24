/**
 * Phase 5.5B feature flag. When PORTFOLIO_IMAGE_PROCESSING is not "on",
 * the 5.5B processing path is dormant and 5.5A behavior is exactly
 * unchanged — finalize moves media to PENDING with no byte-level
 * processing. This lets 5.5B ship as code without altering the validated
 * 5.5A flow until the infrastructure is proven.
 *
 * Turn on ONLY in an environment where sharp is installed and a real
 * bucket is configured, and only after running the 5.5B verification plan.
 */
export function imageProcessingEnabled(): boolean {
  return process.env.PORTFOLIO_IMAGE_PROCESSING === "on";
}
