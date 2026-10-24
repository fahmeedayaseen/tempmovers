import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";

/**
 * Dispatcher authorization. The security core of the Dispatcher Portal.
 *
 * Rules enforced here (never bypassed by a route):
 *  - The caller must hold the DISPATCHER role. Admin roles do NOT grant
 *    dispatcher access — a dispatcher's reach is defined solely by explicit
 *    per-carrier grants, so we intentionally do NOT accept ADMIN here.
 *  - Access is resolved per carrier: there must be a DispatcherCarrierAccess row
 *    for (dispatcher, carrier) with status ACTIVE and not past expiresAt.
 *  - A specific permission is checked against that row's permission set.
 *
 * The permission vocabulary deliberately excludes payment-routing and
 * compliance-approval. Those strings simply don't exist here, so no dispatcher
 * grant can ever carry them.
 */

export const DISPATCHER_PERMISSIONS = [
  "VIEW_LOADS", "RESPOND_TO_OFFERS", "UPDATE_LOAD_STATUS", "UPLOAD_DOCUMENTS",
  "VIEW_SETTLEMENT_STATUS", "MANAGE_DRIVERS", "VIEW_CARRIER_PROFILE",
] as const;
export type DispatcherPermission = (typeof DISPATCHER_PERMISSIONS)[number];

export class DispatcherAccessError extends Error {
  status: number;
  constructor(message: string, status = 403) { super(message); this.status = status; }
}

/** Require the DISPATCHER role. Returns the authed user. */
export async function requireDispatcher(request: Request) {
  return requireRole(request, ["DISPATCHER"] as unknown as ("ADMIN")[]);
}

export type ResolvedAccess = {
  dispatcherId: string;
  carrierId: string;
  permissions: DispatcherPermission[];
};

/**
 * Resolve a dispatcher's ACTIVE access to a specific carrier, optionally
 * requiring a permission. Throws DispatcherAccessError (403/404) when access is
 * missing, not active, expired, or lacks the permission.
 */
export async function resolveCarrierAccess(
  dispatcherId: string,
  carrierId: string,
  requiredPermission?: DispatcherPermission,
): Promise<ResolvedAccess> {
  const access = await prisma.dispatcherCarrierAccess.findUnique({
    where: { dispatcherId_carrierId: { dispatcherId, carrierId } },
  });
  if (!access || access.status !== "ACTIVE") {
    throw new DispatcherAccessError("You do not have access to this carrier.", 403);
  }
  if (access.expiresAt && access.expiresAt.getTime() <= Date.now()) {
    throw new DispatcherAccessError("Your access to this carrier has expired.", 403);
  }
  const permissions = (access.permissions as DispatcherPermission[]) ?? [];
  if (requiredPermission && !permissions.includes(requiredPermission)) {
    throw new DispatcherAccessError(`This action requires the ${requiredPermission} permission for this carrier.`, 403);
  }
  return { dispatcherId, carrierId, permissions };
}

/** List the carrier IDs a dispatcher currently has ACTIVE, unexpired access to. */
export async function listAccessibleCarrierIds(dispatcherId: string): Promise<string[]> {
  const now = new Date();
  const rows = await prisma.dispatcherCarrierAccess.findMany({
    where: { dispatcherId, status: "ACTIVE", OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    select: { carrierId: true },
  });
  return rows.map((r) => r.carrierId);
}

export { AuthError };
