/**
 * Accessorial engine — sums for payment wiring (step 6). One source of truth
 * for how much accessorials add to a customer's charge and to a provider's
 * settlement, so the charge side and the settlement side can never diverge.
 *
 * The three-way split is already frozen per BookingAccessorial:
 *   customerChargeCents  — what the customer pays for the accessorial
 *   platformShareCents   — what the platform keeps
 *   providerShareCents   — what the provider receives (= customer − platform)
 *
 * Which side "funds" the platform share is handled by the base fee model and
 * does not change these sums: the customer always pays sum(customerCharge),
 * the provider always receives sum(providerShare), and the platform always
 * keeps sum(platformShare). Customer − provider == platform holds by
 * construction for accessorials, exactly as for the base fee.
 *
 * Only APPROVED (and later SETTLED) accessorials count — PROPOSED/REJECTED
 * never touch money.
 */
import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";

export type AccessorialSums = { customerChargeCents: number; platformShareCents: number; providerShareCents: number; count: number };

const ZERO: AccessorialSums = { customerChargeCents: 0, platformShareCents: 0, providerShareCents: 0, count: 0 };

function sum(rows: { customerChargeCents: number; platformShareCents: number; providerShareCents: number }[]): AccessorialSums {
  return rows.reduce<AccessorialSums>((a, r) => ({
    customerChargeCents: a.customerChargeCents + r.customerChargeCents,
    platformShareCents: a.platformShareCents + r.platformShareCents,
    providerShareCents: a.providerShareCents + r.providerShareCents,
    count: a.count + 1,
  }), { ...ZERO });
}

const BILLABLE: Prisma.EnumBookingAccessorialStatusFilter = { in: ["APPROVED", "SETTLED"] };

/** Accessorial sums for a job (moving). Uses a tx client when provided. */
export async function accessorialSumsForJob(jobId: string, client: Prisma.TransactionClient | typeof prisma = prisma): Promise<AccessorialSums> {
  const rows = await client.bookingAccessorial.findMany({
    where: { jobId, status: BILLABLE },
    select: { customerChargeCents: true, platformShareCents: true, providerShareCents: true },
  });
  return sum(rows);
}

/** Accessorial sums for a load (freight). */
export async function accessorialSumsForLoad(loadId: string, client: Prisma.TransactionClient | typeof prisma = prisma): Promise<AccessorialSums> {
  const rows = await client.bookingAccessorial.findMany({
    where: { loadId, status: BILLABLE },
    select: { customerChargeCents: true, platformShareCents: true, providerShareCents: true },
  });
  return sum(rows);
}

/** Accessorial sums across several loads (for a settlement period). */
export async function accessorialSumsForLoads(loadIds: string[], client: Prisma.TransactionClient | typeof prisma = prisma): Promise<AccessorialSums> {
  if (loadIds.length === 0) return { ...ZERO };
  const rows = await client.bookingAccessorial.findMany({
    where: { loadId: { in: loadIds }, status: BILLABLE },
    select: { customerChargeCents: true, platformShareCents: true, providerShareCents: true },
  });
  return sum(rows);
}
