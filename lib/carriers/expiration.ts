/**
 * Carrier document & insurance expiration alerts (launch spec phase 3). PURE.
 * Given a carrier's documents/policies and "now", returns which items are
 * expired or expiring soon, so a scheduled job or the admin dashboard can
 * surface them and (for lapsed required insurance) trigger the auto-expire
 * transition handled in lib/carriers/lifecycle.ts.
 */
export type ExpiringItem = {
  kind: "DOCUMENT" | "INSURANCE";
  label: string;
  expiresAt: string | null;
  state: "EXPIRED" | "EXPIRING_SOON" | "OK" | "NO_DATE";
  daysUntilExpiry: number | null;
};

export const EXPIRING_SOON_DAYS = 30;

export function classifyExpiry(expiresAt: string | null, now: Date, soonDays = EXPIRING_SOON_DAYS): { state: ExpiringItem["state"]; daysUntilExpiry: number | null } {
  if (!expiresAt) return { state: "NO_DATE", daysUntilExpiry: null };
  const ms = new Date(expiresAt).getTime() - now.getTime();
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (ms <= 0) return { state: "EXPIRED", daysUntilExpiry: days };
  if (days <= soonDays) return { state: "EXPIRING_SOON", daysUntilExpiry: days };
  return { state: "OK", daysUntilExpiry: days };
}

export type ExpiryInputs = {
  documents: { type: string; expiresAt: string | null }[];
  policies: { type: string; expiresAt: string | null }[];
};

/** Returns only items that need attention (EXPIRED or EXPIRING_SOON). */
export function findExpiringItems(input: ExpiryInputs, now: Date, soonDays = EXPIRING_SOON_DAYS): ExpiringItem[] {
  const out: ExpiringItem[] = [];
  for (const d of input.documents) {
    const c = classifyExpiry(d.expiresAt, now, soonDays);
    if (c.state === "EXPIRED" || c.state === "EXPIRING_SOON") {
      out.push({ kind: "DOCUMENT", label: d.type, expiresAt: d.expiresAt, state: c.state, daysUntilExpiry: c.daysUntilExpiry });
    }
  }
  for (const p of input.policies) {
    const c = classifyExpiry(p.expiresAt, now, soonDays);
    if (c.state === "EXPIRED" || c.state === "EXPIRING_SOON") {
      out.push({ kind: "INSURANCE", label: p.type, expiresAt: p.expiresAt, state: c.state, daysUntilExpiry: c.daysUntilExpiry });
    }
  }
  return out;
}
