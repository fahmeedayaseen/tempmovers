/**
 * Feature-flag framework — DB-backed gate. Thin wrapper over the pure
 * evaluateFlag: loads a flag by key and evaluates it for a context. Fails
 * CLOSED — an unknown/absent flag or any error resolves to OFF, so a missing
 * row can never accidentally expose a future feature.
 *
 * SAFETY: read-only. Never call this from booking/payment/settlement/
 * reconciliation code — those paths must stay independent of flags. This is
 * for gating NEW, future features only.
 */
import { prisma } from "@/lib/db";
import { evaluateFlag, type FeatureContext, type FeatureFlagConfig } from "@/lib/feature-flags/evaluate";

export async function isFeatureEnabled(key: string, ctx: FeatureContext = {}): Promise<boolean> {
  try {
    const flag = await prisma.featureFlag.findUnique({ where: { key } });
    if (!flag) return false; // fail closed
    const config: FeatureFlagConfig = {
      key: flag.key,
      enabled: flag.enabled,
      status: flag.status,
      enabledEnvironments: flag.enabledEnvironments,
      enabledMarkets: flag.enabledMarkets,
      enabledRoles: flag.enabledRoles,
      enabledServiceTypes: flag.enabledServiceTypes,
      enabledPilotGroups: flag.enabledPilotGroups,
    };
    return evaluateFlag(config, { environment: ctx.environment ?? process.env.NODE_ENV, ...ctx });
  } catch {
    return false; // fail closed on any error
  }
}
