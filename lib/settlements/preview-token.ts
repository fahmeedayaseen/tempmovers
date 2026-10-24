/**
 * Settlement preview-token binding (production enhancement). Prevents a
 * time-of-check/time-of-use gap: an admin previews a batch, but between
 * preview and confirmation the underlying loads can change (new captures,
 * deliveries, or a concurrent settlement). This binds the confirmation to the
 * EXACT batch that was reviewed:
 *
 *   - preview computes a deterministic FINGERPRINT of the eligible + skipped
 *     loads (ids + the fields that affect the batch),
 *   - issues a short-lived signed token embedding that fingerprint + scope,
 *   - execution recomputes the fingerprint from CURRENT data and rejects if it
 *     differs (records materially changed) or the token expired.
 *
 * Stateless: the token is a signed JWT, so no table/migration is needed.
 */
import { SignJWT, jwtVerify } from "jose";
import { createHash } from "crypto";

const PREVIEW_TTL_SECONDS = 300; // 5 minutes — short by design

function secret() {
  const value = process.env.AUTH_SECRET;
  if (!value) throw new Error("AUTH_SECRET is not set.");
  return new TextEncoder().encode(value);
}

/** A minimal, stable projection of a load for fingerprinting. */
export type FingerprintLoad = { id: string; grossCarrierCents: number; paymentStatus: string; settlementId: string | null };

/**
 * Deterministic fingerprint of a settlement batch: the sorted eligible IDs,
 * sorted skipped IDs, and a hash of each eligible load's money-affecting
 * fields. Sorting makes it order-independent; any add/remove/amount change
 * flips the hash.
 */
export function computeBatchFingerprint(params: {
  workerId: string;
  periodStart: string; // ISO
  periodEnd: string;
  eligible: FingerprintLoad[];
  skippedLoadIds: string[];
}): string {
  const eligible = [...params.eligible].sort((a, b) => a.id.localeCompare(b.id))
    .map((l) => `${l.id}:${l.grossCarrierCents}:${l.paymentStatus}:${l.settlementId ?? "-"}`);
  const skipped = [...params.skippedLoadIds].sort();
  const payload = JSON.stringify({
    w: params.workerId,
    ps: params.periodStart,
    pe: params.periodEnd,
    e: eligible,
    s: skipped,
  });
  return createHash("sha256").update(payload).digest("hex");
}

export type PreviewTokenClaims = {
  workerId: string;
  periodStart: string;
  periodEnd: string;
  fingerprint: string;
  userId: string;
};

/** Issue a short-lived signed token binding a confirmation to this preview. */
export async function issuePreviewToken(claims: PreviewTokenClaims): Promise<string> {
  return new SignJWT({ ...claims, kind: "settlement-preview" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${PREVIEW_TTL_SECONDS}s`)
    .sign(secret());
}

export type VerifiedToken = { ok: true; claims: PreviewTokenClaims } | { ok: false; reason: "expired" | "invalid" };

/** Verify a preview token's signature + expiry and return its claims. */
export async function verifyPreviewToken(token: string): Promise<VerifiedToken> {
  try {
    const { payload } = await jwtVerify(token, secret());
    if (payload.kind !== "settlement-preview") return { ok: false, reason: "invalid" };
    return { ok: true, claims: { workerId: String(payload.workerId), periodStart: String(payload.periodStart), periodEnd: String(payload.periodEnd), fingerprint: String(payload.fingerprint), userId: String(payload.userId) } };
  } catch (e) {
    // jose throws a distinct error for expiry.
    if (e && typeof e === "object" && "code" in e && (e as { code?: string }).code === "ERR_JWT_EXPIRED") return { ok: false, reason: "expired" };
    return { ok: false, reason: "invalid" };
  }
}
