import { NextResponse } from "next/server";
import { z } from "zod";
import { requireRole, AuthError } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { registeredLoadBoardAdapters } from "@/lib/integrations/adapters/registry";
import { assembleHealthRow, type HealthInputs } from "@/lib/integrations/health";
import { isFeatureEnabled } from "@/lib/feature-flags/gate";

/**
 * Manual "Test Connection" (admin action, read-only). Runs an on-demand,
 * timed health check + status() for ONE provider and returns the same health
 * row shape the dashboard uses. Unlike the dashboard GET, this probes even
 * when the feature flag is OFF — an admin testing credentials before enabling
 * a provider is a legitimate, expected action. It still moves no money and is
 * independent of booking/settlement.
 */
const schema = z.object({ providerKey: z.string().min(1).max(64) });
const TEST_TIMEOUT_MS = 8000;

export async function POST(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["ADMIN", "SUPPORT", "FINANCE_ADMIN", "SUPER_ADMIN"] as unknown as ("ADMIN")[]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const adapter = registeredLoadBoardAdapters().find((a) => a.providerKey === parsed.data.providerKey);
  if (!adapter) return NextResponse.json({ error: "Unknown provider." }, { status: 404 });

  const enabled = await isFeatureEnabled(adapter.featureKey).catch(() => false);
  const inputs: HealthInputs = { providerKey: adapter.providerKey, featureKey: adapter.featureKey, apiVersion: adapter.apiVersion, enabled };

  // Populate local configuration metadata (no network) so Test Connection's
  // output matches the GET health endpoint — a disabled-but-configured
  // provider shows its creds/environment here too. Never fabricates.
  if (adapter.configurationStatus) {
    try { inputs.configuration = adapter.configurationStatus(); } catch { /* leave undefined */ }
  }

  const start = Date.now();
  try {
    inputs.health = await withTimeout(adapter.healthCheck(), TEST_TIMEOUT_MS);
  } catch (e) {
    inputs.health = { ok: false, detail: e instanceof Error ? e.message : "test connection failed/timed out" };
  }
  inputs.latencyMs = Date.now() - start;
  if (adapter.status) {
    try { inputs.status = await withTimeout(adapter.status(), TEST_TIMEOUT_MS); } catch { /* status stays undefined */ }
  }

  const row = assembleHealthRow(inputs);

  // A manual test is worth auditing — it's an admin poking an external system.
  await prisma.auditLog.create({
    data: { actorId: authed.userId, action: "INTEGRATION_TEST_CONNECTION", entityType: "Integration", entityId: adapter.providerKey,
      details: { providerKey: adapter.providerKey, state: row.state, latencyMs: row.latencyMs } },
  });

  return NextResponse.json({ result: row, testedAt: new Date().toISOString() });
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timed out")), ms))]);
}
