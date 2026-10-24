/**
 * Phase 5.5 portfolio validation — PURE (no db, no network, no S3), so
 * every rule is unit-testable without infrastructure. The route layer
 * calls these; the actual S3 HeadObject check and image decoding live in
 * the route/storage layer, but the RULES (what's allowed) live here.
 */

export const PORTFOLIO_ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp"] as const;
export type PortfolioMime = (typeof PORTFOLIO_ALLOWED_MIME)[number];

export const PORTFOLIO_MAX_BYTES = 10 * 1024 * 1024; // 10MB (configurable server-side)
export const PORTFOLIO_MAX_BATCH = 10;
export const PORTFOLIO_MAX_ACTIVE = 50; // non-deleted items per worker
export const PORTFOLIO_MAX_DIMENSION = 12000; // reject absurd/decompression-bomb dimensions
export const PORTFOLIO_MIN_DIMENSION = 1;

const EXT_BY_MIME: Record<PortfolioMime, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

export function isAllowedMime(mime: string): mime is PortfolioMime {
  return (PORTFOLIO_ALLOWED_MIME as readonly string[]).includes(mime);
}

export function extensionForMime(mime: PortfolioMime): string {
  return EXT_BY_MIME[mime];
}

/**
 * Verify the DECLARED mime matches the actual file signature (magic
 * bytes). The spec requires validating both the declared MIME and the
 * real signature — a client can lie about content-type, so at finalize
 * we read the object's leading bytes and confirm. Pure: takes the bytes.
 *
 * JPEG: FF D8 FF
 * PNG:  89 50 4E 47 0D 0A 1A 0A
 * WEBP: "RIFF"...."WEBP" (bytes 0-3 RIFF, 8-11 WEBP)
 * Rejected formats (SVG/GIF/HEIC/TIFF/PDF) will simply not match any
 * branch and return false.
 */
export function signatureMatchesMime(bytes: Uint8Array, declaredMime: PortfolioMime): boolean {
  if (declaredMime === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (declaredMime === "image/png") {
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return bytes.length >= 8 && sig.every((b, i) => bytes[i] === b);
  }
  if (declaredMime === "image/webp") {
    if (bytes.length < 12) return false;
    const riff = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46; // RIFF
    const webp = bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50; // WEBP
    return riff && webp;
  }
  return false;
}

export type PresignValidationInput = { mimeType: string; contentLength: number; currentActiveCount: number };

export function validatePresign(input: PresignValidationInput): { ok: true; mime: PortfolioMime } | { ok: false; error: string } {
  if (!isAllowedMime(input.mimeType)) return { ok: false, error: "Only JPEG, PNG, and WEBP images are allowed." };
  if (input.contentLength <= 0) return { ok: false, error: "File is empty." };
  if (input.contentLength > PORTFOLIO_MAX_BYTES) return { ok: false, error: `Image exceeds the ${PORTFOLIO_MAX_BYTES / 1024 / 1024}MB limit.` };
  if (input.currentActiveCount >= PORTFOLIO_MAX_ACTIVE) return { ok: false, error: `Portfolio is full (max ${PORTFOLIO_MAX_ACTIVE} items).` };
  return { ok: true, mime: input.mimeType };
}

export function validateBatchSize(count: number): { ok: true } | { ok: false; error: string } {
  if (count < 1) return { ok: false, error: "No files in request." };
  if (count > PORTFOLIO_MAX_BATCH) return { ok: false, error: `At most ${PORTFOLIO_MAX_BATCH} files per request.` };
  return { ok: true };
}

export function validateDimensions(width: number | null | undefined, height: number | null | undefined): { ok: true } | { ok: false; error: string } {
  // Unknown dimensions are tolerated (some flows can't decode here) — but
  // if provided, they must be sane. This guards against decompression
  // bombs declaring enormous dimensions.
  if (width == null || height == null) return { ok: true };
  if (width < PORTFOLIO_MIN_DIMENSION || height < PORTFOLIO_MIN_DIMENSION) return { ok: false, error: "Invalid image dimensions." };
  if (width > PORTFOLIO_MAX_DIMENSION || height > PORTFOLIO_MAX_DIMENSION) return { ok: false, error: `Image dimensions exceed ${PORTFOLIO_MAX_DIMENSION}px.` };
  return { ok: true };
}
