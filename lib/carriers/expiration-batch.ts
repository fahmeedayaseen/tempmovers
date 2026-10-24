/**
 * Document-expiration batch processing (launch spec §2). PURE decision layer:
 * given carriers with their documents/insurance + current status, decide which
 * warnings to send and which carriers must transition to EXPIRED_DOCUMENTS (or
 * be restored). A scheduled job calls this and applies the results, writing an
 * audit row for every automatic transition.
 *
 * Warning schedule: 30 / 14 / 7 days before, and on the expiration date.
 */
import { classifyExpiry } from "@/lib/carriers/expiration";
import { autoExpireIfInsuranceLapsed, type CarrierStatus, type InsurancePolicyView } from "@/lib/carriers/lifecycle";

export const WARNING_DAYS = [30, 14, 7, 0];

export type CarrierExpiryState = {
  carrierId: string;
  status: CarrierStatus;
  requiredInsurance: InsurancePolicyView["type"][];
  policies: InsurancePolicyView[];
  documents: { type: string; expiresAt: string | null }[];
};

export type ExpiryWarning = { carrierId: string; item: string; daysUntilExpiry: number };
export type ExpiryTransition = { carrierId: string; from: CarrierStatus; to: CarrierStatus; reason: string };

export type ExpiryBatchResult = {
  warnings: ExpiryWarning[];
  transitions: ExpiryTransition[];
};

/** Which warning threshold (if any) exactly matches daysUntil. */
function warningThreshold(daysUntil: number): number | null {
  return WARNING_DAYS.includes(daysUntil) ? daysUntil : null;
}

export function processExpiryBatch(carriers: CarrierExpiryState[], now: Date): ExpiryBatchResult {
  const warnings: ExpiryWarning[] = [];
  const transitions: ExpiryTransition[] = [];

  for (const c of carriers) {
    // Warnings for every document + policy hitting a threshold.
    const dated = [
      ...c.documents.map((d) => ({ label: d.type, expiresAt: d.expiresAt })),
      ...c.policies.map((p) => ({ label: `${p.type}_INSURANCE`, expiresAt: p.expiresAt })),
    ];
    for (const item of dated) {
      const { daysUntilExpiry, state } = classifyExpiry(item.expiresAt, now);
      if (daysUntilExpiry != null && state !== "EXPIRED") {
        const t = warningThreshold(daysUntilExpiry);
        if (t != null) warnings.push({ carrierId: c.carrierId, item: item.label, daysUntilExpiry });
      }
    }

    // Required-insurance lapse → EXPIRED_DOCUMENTS (rule).
    const toExpired = autoExpireIfInsuranceLapsed(c.status, c.policies, c.requiredInsurance, now);
    if (toExpired) {
      transitions.push({ carrierId: c.carrierId, from: c.status, to: toExpired, reason: "Required insurance lapsed." });
    }
  }

  return { warnings, transitions };
}
