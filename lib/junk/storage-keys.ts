import { randomUUID } from "crypto";

// Junk removal — VASRUE Digital Media, 28 October 2026. Private object keys for
// junk photos and dump receipts. Keys are namespaced so a route can check that
// a key handed back by a client really was issued for that customer or job.

export const JUNK_UPLOAD_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "application/pdf"] as const;
export const JUNK_PROOF_KINDS = ["BEFORE", "AFTER", "DUMP_RECEIPT"] as const;
export type JunkProofKind = (typeof JUNK_PROOF_KINDS)[number];
export const MAX_JUNK_PHOTOS_PER_SET = 12;

const EXTENSION_BY_TYPE: Record<(typeof JUNK_UPLOAD_CONTENT_TYPES)[number], string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic", "application/pdf": "pdf",
};

export function junkBookingPhotoPrefix(customerId: string) {
  return `junk/customers/${customerId}/`;
}

export function junkProofPrefix(jobId: string, kind: JunkProofKind) {
  return `junk/jobs/${jobId}/${kind.toLowerCase()}/`;
}

export function buildJunkBookingPhotoKey(customerId: string, contentType: (typeof JUNK_UPLOAD_CONTENT_TYPES)[number]) {
  return `${junkBookingPhotoPrefix(customerId)}${randomUUID()}.${EXTENSION_BY_TYPE[contentType]}`;
}

export function buildJunkProofKey(jobId: string, kind: JunkProofKind, contentType: (typeof JUNK_UPLOAD_CONTENT_TYPES)[number]) {
  return `${junkProofPrefix(jobId, kind)}${randomUUID()}.${EXTENSION_BY_TYPE[contentType]}`;
}

/** A key is acceptable only if it sits directly under the expected prefix — no traversal, no other tenant's folder. */
export function isKeyUnder(key: string, prefix: string): boolean {
  if (!key.startsWith(prefix)) return false;
  const rest = key.slice(prefix.length);
  return /^[0-9a-f-]{36}\.(jpg|png|webp|heic|pdf)$/.test(rest);
}
