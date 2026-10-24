/**
 * Phase 5.5B — image-processing service.
 *
 * ⚠️ CODE COMPLETE / INFRASTRUCTURE VALIDATION PENDING ⚠️
 * Every function in this file depends on `sharp` decoding a REAL uploaded
 * image and on real object storage. NONE of it has been executed in this
 * environment (no sharp binary, no S3, no real files). Do not represent
 * magic-byte detection, EXIF stripping, dimension/bomb protection, or
 * thumbnail generation as production-ready until the Phase 5.5B
 * verification plan has been run against an actual bucket with real
 * uploads. See docs/PHASE-5.5B-VERIFICATION-PLAN.md.
 *
 * Design notes:
 *  - The PURE decision logic (what counts as a bomb, dimension gates,
 *    thumbnail sizing, magic-byte matching) lives in image-analysis.ts
 *    and validation.ts and IS unit-tested. This file is the thin,
 *    sharp/S3-bound orchestration that can only be verified at runtime.
 *  - sharp is imported dynamically so that (a) route bundles that never
 *    process images don't pull it in, and (b) a missing native binary
 *    surfaces as a clear runtime error at call time, not an import crash.
 */
import { getObjectBytes, putObjectBytes, buildThumbnailKey, headObject } from "@/lib/storage";
import { signatureMatchesMime, isAllowedMime, PORTFOLIO_MAX_BYTES, type PortfolioMime } from "@/lib/portfolio/validation";
import { analyzeImageMeta, thumbnailTarget, MAX_PIXELS, type ImageMeta } from "@/lib/portfolio/image-analysis";

export type ProcessResult =
  | { ok: true; width: number; height: number; sanitizedKey: string; thumbnailKey: string }
  | { ok: false; reason: string };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadSharp(): Promise<any> {
  try {
    // Dynamic import; sharp is an optional native dep.
    const mod = await import("sharp");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (mod as any).default ?? mod;
  } catch {
    throw new Error("Image processing is unavailable (sharp not installed).");
  }
}

/**
 * Full processing pass for one uploaded portfolio object. Intended to run
 * asynchronously after finalize (or on approval), NOT inline in the
 * request. Steps, in order:
 *   1. read the object bytes from storage,
 *   2. verify the magic bytes match the declared MIME (real signature
 *      check — the 5.5A finalize gate only checked declared type),
 *   3. decode metadata with sharp and run the pure bomb/dimension gates,
 *   4. re-encode WITHOUT metadata (strips EXIF/GPS) back to the same key,
 *   5. generate a downscaled WEBP thumbnail to the thumbnail key.
 * Returns the verified dimensions and the thumbnail key for the caller to
 * persist, or a failure reason for the caller to reject the media.
 */
export async function processPortfolioImage(params: { storageKey: string; declaredMime: string }): Promise<ProcessResult> {
  if (!isAllowedMime(params.declaredMime)) return { ok: false, reason: "Unsupported image type." };
  const declaredMime = params.declaredMime as PortfolioMime;

  // P0-04: re-validate object metadata immediately before downloading —
  // the object could have changed/grown since finalize. Cheap HEAD guard
  // against downloading something oversized or gone.
  const head = await headObject(params.storageKey);
  if (!head) return { ok: false, reason: "Object no longer exists in storage." };
  if (head.contentLength <= 0 || head.contentLength > PORTFOLIO_MAX_BYTES) {
    return { ok: false, reason: "Object size is outside allowed limits." };
  }

  const bytes = await getObjectBytes(params.storageKey);

  // 2. Real magic-byte signature check on the actual bytes.
  if (!signatureMatchesMime(new Uint8Array(bytes.subarray(0, 16)), declaredMime)) {
    return { ok: false, reason: "File contents did not match an accepted image type." };
  }

  const sharp = await loadSharp();

  // 3. Decode metadata and run pure gates. P0-01: DO NOT disable libvips'
  // own pixel limit — a decompression bomb does its damage during the
  // decode/metadata read itself. We cap libvips at MAX_PIXELS so an
  // oversized raster is refused by the decoder before our pure gate even
  // runs; the pure analyzeImageMeta is a second, defense-in-depth check.
  let meta;
  try {
    meta = await sharp(bytes, { limitInputPixels: MAX_PIXELS }).metadata();
  } catch {
    return { ok: false, reason: "Image could not be decoded (may exceed pixel limits)." };
  }
  const imageMeta: ImageMeta = { width: meta.width ?? 0, height: meta.height ?? 0, byteSize: bytes.length, format: meta.format ?? "" };
  const analysis = analyzeImageMeta(imageMeta);
  if (!analysis.ok) return { ok: false, reason: analysis.reason };

  // 4. Re-encode WITHOUT metadata → strips EXIF including GPS. Same pixel
  // cap applied to every subsequent pipeline so a bomb can't slip through
  // a later stage either.
  let sanitized: Buffer;
  try {
    const pipeline = sharp(bytes, { limitInputPixels: MAX_PIXELS }).rotate(); // bake orientation, then drop EXIF
    if (declaredMime === "image/jpeg") sanitized = await pipeline.jpeg({ quality: 88 }).toBuffer();
    else if (declaredMime === "image/png") sanitized = await pipeline.png().toBuffer();
    else sanitized = await pipeline.webp({ quality: 88 }).toBuffer();
  } catch {
    return { ok: false, reason: "Image could not be processed." };
  }
  await putObjectBytes({ key: params.storageKey, contentType: declaredMime, body: sanitized });

  // 5. Thumbnail (downscaled WEBP). P1: a thumbnail failure is NOT treated
  // as full success — it returns ok:false so the caller marks processing
  // FAILED and does NOT allow approval. The sanitized full image is
  // already written, so a retry regenerates just the thumbnail.
  const target = thumbnailTarget(imageMeta.width, imageMeta.height);
  const thumbnailKey = buildThumbnailKey(params.storageKey);
  try {
    const thumb = await sharp(sanitized, { limitInputPixels: MAX_PIXELS }).resize(target.width, target.height, { fit: "inside", withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
    await putObjectBytes({ key: thumbnailKey, contentType: "image/webp", body: thumb });
  } catch {
    return { ok: false, reason: "Thumbnail generation failed." };
  }

  return { ok: true, width: imageMeta.width, height: imageMeta.height, sanitizedKey: params.storageKey, thumbnailKey };
}
