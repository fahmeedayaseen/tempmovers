/**
 * Phase 5.5 public-safe portfolio serialization. The spec is explicit:
 * public responses must NEVER include storageKey, thumbnailKey, bucket,
 * presigned URLs, upload tokens, moderationNote, admin IDs, reporter
 * details, or any pending/rejected/removed record.
 *
 * PUBLIC_PORTFOLIO_MEDIA_SELECT is the Prisma select for public reads —
 * it deliberately omits every private column, so a public route can't
 * accidentally leak one even if a caller forgets to serialize. The
 * delivery/thumbnail URLs are NOT stored here; the route resolves them
 * from the (private) keys via signed URLs at read time and attaches them
 * through toPublicMedia — the raw key never reaches the client.
 */
export const PUBLIC_PORTFOLIO_MEDIA_SELECT = {
  id: true,
  title: true,
  description: true,
  width: true,
  height: true,
  isPrimary: true,
  displayOrder: true,
  approvedAt: true,
  category: { select: { id: true, name: true, slug: true } },
} as const;

// Owner/admin select — adds moderation state + worker-visible rejection
// reason, but STILL no storage credentials or raw keys. thumbnailKey/
// storageKey are resolved to signed URLs by the route, never sent raw.
export const OWNER_PORTFOLIO_MEDIA_SELECT = {
  id: true,
  title: true,
  description: true,
  width: true,
  height: true,
  isPrimary: true,
  displayOrder: true,
  status: true,
  rejectionReason: true,
  mimeType: true,
  fileSize: true,
  createdAt: true,
  submittedAt: true,
  approvedAt: true,
  category: { select: { id: true, name: true, slug: true } },
} as const;

/**
 * Attach a signed delivery URL (resolved from the private key by the
 * caller) to a public-selected row. Kept separate so the select stays
 * pure data and URL-signing (which needs S3) happens in the route.
 */
export function toPublicMedia<T extends { id: string }>(row: T, deliveryUrl: string | null, thumbnailUrl: string | null) {
  return { ...row, deliveryUrl, thumbnailUrl };
}
