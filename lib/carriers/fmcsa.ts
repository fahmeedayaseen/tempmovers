/**
 * FMCSA carrier verification (launch spec rule #4). Performs a point-in-time
 * authority lookup and returns a snapshot to persist as a CarrierFmcsaCheck —
 * WITH its checkedAt date and the raw source result. FMCSA data is never
 * treated as permanently valid; callers re-check and can detect staleness.
 *
 * Gated by the FMCSA_VERIFICATION feature flag + a configured provider. When
 * unconfigured or the flag is off, returns a check row with checkError set
 * (lookup-failure handling, rule) rather than throwing — onboarding continues
 * and an admin can review manually.
 */
import { isFeatureEnabled } from "@/lib/feature-flags/gate";
import type { CarrierVerificationAdapter } from "@/lib/integrations/freight-adapters";

export type FmcsaSnapshot = {
  dotNumber?: string;
  mcNumber?: string;
  operatingStatus: string | null;
  authorized: boolean | null;
  sourceResult: unknown;
  checkedAt: string;
  checkError: string | null;
};

/** How stale an FMCSA check may be before it should be re-run (days). */
export const FMCSA_MAX_AGE_DAYS = 30;

export function isFmcsaCheckStale(checkedAt: string, now: Date = new Date()): boolean {
  const ageMs = now.getTime() - new Date(checkedAt).getTime();
  return ageMs > FMCSA_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * Run a verification. `adapter` is optional so the platform works without a
 * live FMCSA provider (returns checkError). Never throws — a failed lookup is
 * data, not an exception, so onboarding isn't blocked by an outage.
 */
export async function runFmcsaCheck(
  input: { dotNumber?: string; mcNumber?: string },
  adapter?: CarrierVerificationAdapter | null,
): Promise<FmcsaSnapshot> {
  const now = new Date().toISOString();
  const base: FmcsaSnapshot = {
    dotNumber: input.dotNumber, mcNumber: input.mcNumber,
    operatingStatus: null, authorized: null, sourceResult: null, checkedAt: now, checkError: null,
  };

  let enabled = false;
  try { enabled = await isFeatureEnabled("FMCSA_VERIFICATION"); } catch { enabled = false; }
  if (!enabled) return { ...base, checkError: "FMCSA verification is not enabled." };
  if (!adapter) return { ...base, checkError: "No FMCSA verification provider configured." };
  if (!input.dotNumber && !input.mcNumber) return { ...base, checkError: "A DOT or MC number is required." };

  try {
    const result = await adapter.lookupAuthority({ dotNumber: input.dotNumber, mcNumber: input.mcNumber });
    if (!result) return { ...base, checkError: "No FMCSA record found." };
    return {
      ...base,
      authorized: result.active,
      operatingStatus: result.active ? "ACTIVE" : "INACTIVE",
      sourceResult: result.raw ?? null,
    };
  } catch (e) {
    // Lookup failure handling: capture the error, don't throw.
    return { ...base, checkError: e instanceof Error ? e.message : "FMCSA lookup failed." };
  }
}
