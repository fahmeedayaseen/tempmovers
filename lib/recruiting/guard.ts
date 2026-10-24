import { requireRole, AuthError } from "@/lib/auth";

/**
 * Recruiting access guard. RECRUITER + admin roles may use the CRM. The CRM
 * models carry NO finance/factoring/payment/compliance data, so role-gating
 * here plus the models' own shape enforces the handoff's permission rule:
 * recruiters cannot reach finance, factoring, payment assignments, or
 * compliance-only notes.
 */
export const RECRUITING_ROLES = ["RECRUITER", "ADMIN", "SUPPORT", "SUPER_ADMIN"] as const;

export async function requireRecruiter(request: Request) {
  return requireRole(request, RECRUITING_ROLES as unknown as ("ADMIN")[]);
}

export { AuthError };
