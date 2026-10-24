import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { FUTURE_FEATURE_KEYS } from "@/lib/feature-flags/evaluate";

/**
 * Admin feature-flag management (future-development extension points). GET
 * lists flags; PUT upserts one flag's enablement + targeting. Restricted to
 * privileged admins. Turning a future feature on is a deliberate action here
 * and nowhere else; all flags default to DISABLED.
 */
const WRITE_ROLES = ["ADMIN", "FINANCE_ADMIN", "SUPER_ADMIN"] as const;

const putSchema = z.object({
  key: z.string().min(1).max(64),
  enabled: z.boolean().optional(),
  status: z.enum(["DISABLED", "PILOT", "ENABLED"]).optional(),
  enabledEnvironments: z.array(z.string()).optional(),
  enabledMarkets: z.array(z.string()).optional(),
  enabledRoles: z.array(z.enum(["CUSTOMER", "MOVER", "DRIVER", "ADMIN", "SUPPORT", "FINANCE_ADMIN", "SUPER_ADMIN"])).optional(),
  enabledServiceTypes: z.array(z.string()).optional(),
  enabledPilotGroups: z.array(z.string()).optional(),
  description: z.string().max(500).nullable().optional(),
  configuration: z.any().optional(),
});

export async function GET(request: Request) {
  try {
    await requireRole(request, WRITE_ROLES as unknown as ("ADMIN")[]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const flags = await prisma.featureFlag.findMany({ orderBy: { key: "asc" } });
  // Surface the canonical future-feature keys even if no row exists yet, so
  // the admin UI shows the full set (all effectively DISABLED).
  const known = new Set(flags.map(f => f.key));
  const missing = FUTURE_FEATURE_KEYS.filter(k => !known.has(k)).map(k => ({ key: k, enabled: false, status: "DISABLED" as const, notConfigured: true }));
  return NextResponse.json({ flags, unconfigured: missing });
}

export async function PUT(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, WRITE_ROLES as unknown as ("ADMIN")[]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const parsed = putSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const { key, configuration, ...rest } = parsed.data;

  const data = {
    ...rest,
    ...(configuration !== undefined ? { configuration } : {}),
  };

  const flag = await prisma.featureFlag.upsert({
    where: { key },
    create: { key, enabled: rest.enabled ?? false, status: rest.status ?? "DISABLED", description: rest.description ?? null,
      enabledEnvironments: rest.enabledEnvironments ?? [], enabledMarkets: rest.enabledMarkets ?? [],
      enabledRoles: rest.enabledRoles ?? [], enabledServiceTypes: rest.enabledServiceTypes ?? [],
      enabledPilotGroups: rest.enabledPilotGroups ?? [], configuration: configuration ?? undefined },
    update: data,
  });

  await prisma.auditLog.create({
    data: { actorId: authed.userId, action: "FEATURE_FLAG_UPDATED", entityType: "FeatureFlag", entityId: flag.id, details: { key: flag.key, enabled: flag.enabled, status: flag.status } },
  });

  return NextResponse.json({ flag });
}
