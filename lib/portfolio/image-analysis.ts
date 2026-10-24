/**
 * Phase 5.5B — PURE image-metadata analysis. Takes already-extracted
 * metadata (width, height, byte size, format) and decides whether the
 * image is acceptable. No sharp, no S3 — so these decision rules are
 * fully unit-testable in this environment. The sharp-dependent step that
 * PRODUCES this metadata lives in image-processing.ts and is the part
 * that cannot be verified here.
 *
 * These thresholds are deliberately conservative; tune against real
 * traffic once validated.
 */

export const MAX_PIXELS = 40_000_000; // 40 MP — above typical phone/pro camera output
export const MAX_DIMENSION = 12_000;  // per-side cap (matches validation.ts)
export const MIN_DIMENSION = 1;
// A "decompression bomb" is a small file that decodes to an enormous
// raster. Flag when decoded pixel area is wildly disproportionate to the
// compressed byte size. 1 byte -> N pixels; PNG/WEBP can legitimately hit
// ~100-300:1 on flat images, so we gate well above that.
export const MAX_PIXELS_PER_BYTE = 1000;

export type ImageMeta = { width: number; height: number; byteSize: number; format: string };

export type AnalysisResult = { ok: true } | { ok: false; reason: string };

export function analyzeImageMeta(meta: ImageMeta): AnalysisResult {
  if (!Number.isFinite(meta.width) || !Number.isFinite(meta.height)) return { ok: false, reason: "Image dimensions could not be read." };
  if (meta.width < MIN_DIMENSION || meta.height < MIN_DIMENSION) return { ok: false, reason: "Image dimensions are invalid." };
  if (meta.width > MAX_DIMENSION || meta.height > MAX_DIMENSION) return { ok: false, reason: `Image exceeds ${MAX_DIMENSION}px on a side.` };

  const pixels = meta.width * meta.height;
  if (pixels > MAX_PIXELS) return { ok: false, reason: `Image exceeds ${MAX_PIXELS / 1_000_000} megapixels.` };

  // Decompression-bomb heuristic: decoded area vs compressed size.
  if (meta.byteSize > 0 && pixels / meta.byteSize > MAX_PIXELS_PER_BYTE) {
    return { ok: false, reason: "Image failed decompression-bomb safety checks." };
  }

  return { ok: true };
}

/**
 * Target thumbnail box (longest edge). The generator scales down to fit
 * within this while preserving aspect ratio; it never upscales.
 */
export const THUMBNAIL_MAX_EDGE = 400;

export function thumbnailTarget(width: number, height: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= THUMBNAIL_MAX_EDGE) return { width, height }; // never upscale
  const scale = THUMBNAIL_MAX_EDGE / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}
