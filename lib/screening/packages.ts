export type ApplicantRole = "MOVER" | "BOX_TRUCK_DRIVER" | "SEMI_DRIVER";

export type ScreeningQuote = {
  role: ApplicantRole;
  packageSlug: string;
  displayName: string;
  baseAmountCents: number;
  estimatedPassThroughCents: number;
  totalAmountCents: number;
  requiredCredentials: string[];
};

/**
 * The dollar values here are configuration defaults, not hard-coded legal
 * promises — the handoff is explicit that active pricing should live in an
 * admin-managed table or environment-backed configuration before
 * production. Kept as literal defaults for now (matching this codebase's
 * existing pattern for the subscription/moving-job pricing constants),
 * with a clear TODO rather than fabricating a config-table migration this
 * pass didn't otherwise call for.
 */
const PACKAGES: Record<ApplicantRole, Omit<ScreeningQuote, "role" | "totalAmountCents">> = {
  MOVER: {
    packageSlug: process.env.CHECKR_MOVER_PACKAGE ?? "",
    displayName: "Mover identity and background screening",
    baseAmountCents: 5999,
    estimatedPassThroughCents: 0,
    requiredCredentials: ["IDENTITY", "BACKGROUND", "PHONE", "EMAIL"],
  },
  BOX_TRUCK_DRIVER: {
    packageSlug: process.env.CHECKR_BOX_TRUCK_PACKAGE ?? "",
    displayName: "Box-truck driver screening and MVR",
    baseAmountCents: 6949,
    estimatedPassThroughCents: 0,
    requiredCredentials: ["IDENTITY", "BACKGROUND", "LICENSE", "MVR", "INSURANCE", "VEHICLE", "PHONE", "EMAIL"],
  },
  SEMI_DRIVER: {
    packageSlug: process.env.CHECKR_SEMI_PACKAGE ?? "",
    displayName: "Commercial driver screening and CDL/MVR review",
    baseAmountCents: 7449,
    estimatedPassThroughCents: 0,
    requiredCredentials: ["IDENTITY", "BACKGROUND", "CDL", "MVR", "INSURANCE", "VEHICLE", "DOT", "MC", "PHONE", "EMAIL"],
  },
};

export class ScreeningPackageNotConfiguredError extends Error {
  constructor(role: ApplicantRole) {
    super(`No Checkr package configured for role ${role}.`);
  }
}

export function getScreeningQuote(role: ApplicantRole): ScreeningQuote {
  const item = PACKAGES[role];
  if (!item.packageSlug) throw new ScreeningPackageNotConfiguredError(role);
  return { role, ...item, totalAmountCents: item.baseAmountCents + item.estimatedPassThroughCents };
}
