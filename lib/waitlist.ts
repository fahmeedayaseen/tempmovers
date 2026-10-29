import { z } from "zod";

/**
 * Launch waitlist — VASRUE Digital Media, 29 October 2026.
 *
 * Shared rules for the waitlist signup (Carl's waitlist work order §3–§6):
 * what a valid submission is, how the email is normalised, which interests
 * exist, how UTM parameters become the `source` field, and the per-IP rate
 * limit. The public coming-soon page that serves tempmovers.com before launch
 * posts to an endpoint with exactly this contract, so signups taken there and
 * signups taken by this app land in the same WaitlistSignup table the same way.
 */

export const WAITLIST_INTERESTS = ["MOVING_LABOR", "BOX_TRUCK", "FREIGHT", "JUNK_REMOVAL"] as const;
export type WaitlistInterest = (typeof WAITLIST_INTERESTS)[number];

export const WAITLIST_INTEREST_LABELS: Record<WaitlistInterest, string> = {
  MOVING_LABOR: "Moving labor",
  BOX_TRUCK: "Box truck",
  FREIGHT: "Freight",
  JUNK_REMOVAL: "Junk removal",
};

/** Name of the hidden field a person never sees; bots that fill it are rejected. */
export const WAITLIST_HONEYPOT_FIELD = "company";

const optionalTrimmed = (max: number) =>
  z
    .string()
    .max(max * 4)
    .optional()
    .nullable()
    .transform((v) => {
      const s = (v ?? "").trim().slice(0, max);
      return s.length ? s : null;
    });

export const waitlistSignupSchema = z.object({
  email: z
    .string()
    .max(254)
    .transform((v) => v.trim().toLowerCase())
    .pipe(z.string().email().max(254)),
  audience: z.enum(["CUSTOMER", "WORKER"]),
  zipCode: z
    .string()
    .max(20)
    .optional()
    .nullable()
    .transform((v) => (v ?? "").trim())
    .refine((v) => v === "" || /^\d{5}(-\d{4})?$/.test(v), { message: "Enter a 5-digit ZIP code." })
    .transform((v) => (v === "" ? null : v.slice(0, 5))),
  interests: z
    .array(z.enum(WAITLIST_INTERESTS))
    .max(WAITLIST_INTERESTS.length)
    .optional()
    .nullable()
    .transform((v) => Array.from(new Set(v ?? []))),
  hasTruck: z.boolean().optional().nullable(),
  firstName: optionalTrimmed(60),
  source: optionalTrimmed(500),
  [WAITLIST_HONEYPOT_FIELD]: z.string().max(500).optional().nullable(),
});

export type WaitlistSignupInput = z.output<typeof waitlistSignupSchema>;

/** The truck question is asked on the worker path only; a customer's answer is ignored. */
export function normaliseHasTruck(input: Pick<WaitlistSignupInput, "audience" | "hasTruck">): boolean | null {
  return input.audience === "WORKER" && typeof input.hasTruck === "boolean" ? input.hasTruck : null;
}

/** True when the hidden honeypot field carries anything at all. */
export function honeypotTripped(input: Record<string, unknown>): boolean {
  const v = input[WAITLIST_HONEYPOT_FIELD];
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * utm_source / utm_medium / utm_campaign from a query string, as a compact
 * JSON string for the `source` column, or null when none are present.
 */
export function utmSourceFromSearch(search: string): string | null {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const out: Record<string, string> = {};
  for (const key of ["utm_source", "utm_medium", "utm_campaign"] as const) {
    const v = params.get(key)?.trim();
    if (v) out[key] = v.slice(0, 150);
  }
  return Object.keys(out).length ? JSON.stringify(out) : null;
}

// ---------------------------------------------------------------------------
// Rate limit — about 5 signups a minute per IP (work order §5.3).
// A fixed one-minute window held in this server instance's memory. It stops a
// single client hammering the form; it is not a global quota across instances,
// which the honeypot and the upsert (no duplicates possible) cover for v1.
// ---------------------------------------------------------------------------

export const WAITLIST_RATE_LIMIT = { max: 5, windowMs: 60_000 } as const;

const hits = new Map<string, { count: number; windowStart: number }>();

export function waitlistRateLimited(ip: string, now = Date.now()): boolean {
  if (hits.size > 5_000) {
    for (const [k, v] of hits) if (now - v.windowStart >= WAITLIST_RATE_LIMIT.windowMs) hits.delete(k);
  }
  const entry = hits.get(ip);
  if (!entry || now - entry.windowStart >= WAITLIST_RATE_LIMIT.windowMs) {
    hits.set(ip, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  return entry.count > WAITLIST_RATE_LIMIT.max;
}

/** Client IP as Vercel / a proxy reports it; "unknown" groups clients with no header. */
export function clientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim() || "unknown";
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

/** One CSV cell, quoted, with spreadsheet formula injection neutralised. */
export function csvCell(value: unknown): string {
  let s = value == null ? "" : Array.isArray(value) ? value.join("; ") : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
