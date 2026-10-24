/**
 * Permission negative-test harness. Builds REAL authenticated requests against
 * the ACTUAL exported route handlers, backed by the test database. No auth logic
 * is recreated here — a test fails if someone later weakens requireRole, a
 * dispatcher grant, an ownership check, or a brokerage gate.
 *
 * Requires a migrated test database (DATABASE_URL pointing at it). These are
 * integration tests: they seed users/carriers/loads, mint real sessions via
 * createSession, and assert on real HTTP status codes and serialized JSON.
 */
import { prisma } from "@/lib/db";
import { createSession } from "@/lib/auth";
import type { UserRole } from "@prisma/client";

let seq = 0;
const uniq = (p: string) => `${p}-${Date.now()}-${seq++}`;

/** Create an ACTIVE user of a role and return { id, jwt }. */
export async function makeUser(role: UserRole): Promise<{ id: string; jwt: string; role: UserRole }> {
  const user = await prisma.user.create({
    data: { email: `${uniq("u")}@test.local`, role, status: "ACTIVE", passwordHash: "x" },
    select: { id: true, role: true },
  });
  const { jwt } = await createSession(user.id, role);
  return { id: user.id, jwt, role };
}

/** Build a Request with a Bearer token for a seeded user. */
export function authedRequest(jwt: string | null, url: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (jwt) headers.set("authorization", `Bearer ${jwt}`);
  headers.set("content-type", "application/json");
  return new Request(`http://test.local${url}`, { ...init, headers });
}

/** Create a carrier owned by a user. */
export async function makeCarrier(ownerUserId: string, overrides: Record<string, unknown> = {}): Promise<{ id: string }> {
  return prisma.carrier.create({
    data: { ownerUserId, legalBusinessName: uniq("Carrier"), dotNumber: uniq("DOT"), mcNumber: uniq("MC"), status: "ACTIVE", ...overrides },
    select: { id: true },
  });
}

/** Grant a dispatcher access to a carrier with a permission set. */
export async function grantDispatcher(dispatcherId: string, carrierId: string, permissions: string[], status = "ACTIVE") {
  return prisma.dispatcherCarrierAccess.create({
    data: { dispatcherId, carrierId, permissions, status: status as never, grantedAt: new Date() },
  });
}

/** Create a freight load, optionally assigned to a carrier and owned by a shipper. */
export async function makeLoad(overrides: Record<string, unknown> = {}): Promise<{ id: string }> {
  return prisma.freightLoad.create({
    data: {
      status: "AVAILABLE", commodity: "Test goods", equipmentType: "DRY_VAN",
      customerLinehaulCents: 200000, customerFuelSurchargeCents: 30000, customerAccessorialsCents: 0, customerTotalCents: 230000,
      carrierLinehaulCents: 170000, carrierFuelSurchargeCents: 25000, carrierAccessorialsCents: 0, carrierTotalCents: 195000,
      grossMarginCents: 35000, platformRevenueCents: 35000, processingFeesCents: 0,
      creationKey: uniq("ck"),
      ...overrides,
    },
    select: { id: true },
  });
}

/** Ensure a brokerage capability flag is set to a value in the test DB. */
export async function setBrokerageFlag(flagKey: string, enabled: boolean) {
  await prisma.featureFlag.upsert({
    where: { key: flagKey },
    create: { key: flagKey, enabled },
    update: { enabled },
  });
}

/** Read a handler's Response body as parsed JSON. */
export async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  try { return await res.clone().json(); } catch { return {}; }
}
