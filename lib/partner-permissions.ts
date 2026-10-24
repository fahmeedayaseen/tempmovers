import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

type Client = Prisma.TransactionClient | typeof prisma;
type PartnerWithCustomer = { id: string; displayName: string; monthlyInvoicing: boolean; customer: { id: string; userId: string } } & Record<string, unknown>;

/**
 * Resolves read/write access to a partner organization's resources.
 * Originally built for preferred-network management (Owner/Admin/
 * Manager only for writes), generalized during Phase 3.5 specifically
 * to close the gap it was built to eventually close: every partner-
 * scoped route in this codebase had only ever checked the single
 * owning CustomerProfile, never PartnerMember at all — which itself
 * existed in the schema, completely unused, since long before this
 * helper was written.
 *
 * Both functions now return the fetched partner object on success,
 * not just an allowed/denied boolean — every caller migrated this
 * round was doing a second, redundant findUnique for the same row
 * immediately after the ownership check; returning it here removes
 * that duplicate fetch across the board rather than just for one
 * route.
 *
 * Also fixes a real bug found while doing this refactor: the previous
 * version returned `allowed: true` for an ADMIN caller *before* ever
 * checking whether the partner existed at all — an admin querying a
 * nonexistent partnerId would have gotten a false "allowed," pushing a
 * confusing null-partner failure downstream in the caller instead of a
 * clean 404 here. Both functions now fetch and check existence first,
 * for every role, including ADMIN.
 *
 * `role` on PartnerMember is a loose string, not an enforced enum — no
 * route anywhere has ever wired a specific set of role values, so
 * there's no established convention to match against. Matches
 * case-insensitively against OWNER/ADMIN/MANAGER, OR canApprove: true,
 * whichever the org actually used when adding the member — rather than
 * force a single convention that might not match how it's actually
 * populated.
 */
const WRITE_ROLES = ["OWNER", "ADMIN", "MANAGER"];

export type PartnerAccessResult =
  | { allowed: true; partner: PartnerWithCustomer }
  | { allowed: false; reason: string };

export async function resolvePartnerWriteAccess(
  client: Client,
  partnerId: string,
  authed: { userId: string; role: string },
): Promise<PartnerAccessResult> {
  const partner = await client.partnerOrganization.findUnique({ where: { id: partnerId }, include: { customer: true } });
  if (!partner) return { allowed: false, reason: "Partner not found." };
  if (authed.role === "ADMIN") return { allowed: true, partner };
  if (partner.customer.userId === authed.userId) return { allowed: true, partner };

  const member = await client.partnerMember.findUnique({ where: { partnerId_userId: { partnerId, userId: authed.userId } } });
  if (!member) return { allowed: false, reason: "You are not a member of this partner organization." };
  if (member.canApprove || WRITE_ROLES.includes(member.role.toUpperCase())) return { allowed: true, partner };

  return { allowed: false, reason: "Your role on this partner account does not have permission to make changes here." };
}

/**
 * Broader than write access, deliberately — any member of the partner
 * org can view its resources, even a plain MEMBER who can't edit them.
 */
export async function resolvePartnerReadAccess(
  client: Client,
  partnerId: string,
  authed: { userId: string; role: string },
): Promise<PartnerAccessResult> {
  const partner = await client.partnerOrganization.findUnique({ where: { id: partnerId }, include: { customer: true } });
  if (!partner) return { allowed: false, reason: "Partner not found." };
  if (authed.role === "ADMIN") return { allowed: true, partner };
  if (partner.customer.userId === authed.userId) return { allowed: true, partner };

  const member = await client.partnerMember.findUnique({ where: { partnerId_userId: { partnerId, userId: authed.userId } } });
  if (!member) return { allowed: false, reason: "You are not a member of this partner organization." };
  return { allowed: true, partner };
}
