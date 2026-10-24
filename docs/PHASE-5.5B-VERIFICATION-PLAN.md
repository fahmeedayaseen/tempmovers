# Phase 5.5B — Verification Plan (run against real S3 + sharp)

**Status of 5.5B code: ✅ Code Complete · ⏳ Infrastructure Validation Pending**

None of the image-processing or storage-lifecycle behavior below has
been executed in the build environment (no `sharp` binary, no network, no
real bucket). The *pure decision logic* underneath it IS unit-tested and
passing (see `tests/portfolio/image-analysis.test.ts`,
`validation.test.ts`, `state.test.ts`, `cleanup` cases). This plan is the
runtime verification to execute once a real dev environment with an S3
bucket and `sharp` is available. Do not mark Phase 5.5B complete until
every box below passes and the results are recorded.

## Preconditions

- [ ] Phase 5.5A has passed: `prisma generate`, `migrate dev`, `tsc --noEmit`, `lint`, `test`, `build`, and an end-to-end upload against real storage.
- [ ] `npm ci` installs `sharp` successfully on the target platform (native binary present).
- [ ] `AWS_S3_BUCKET` / `AWS_REGION` / `AWS_S3_KMS_KEY_ID` configured; bucket private; least-privilege IAM.
- [ ] `PORTFOLIO_IMAGE_PROCESSING=on` set ONLY in this validation environment.

## A. Magic-byte / signature validation

- [ ] Upload a valid JPEG, PNG, WEBP → each passes `signatureMatchesMime` and processes.
- [ ] Rename a `.svg`/`.txt`/`.pdf` to `.jpg`, set content-type `image/jpeg`, upload → processing REJECTS with "File contents did not match…", media set REJECTED + soft-deleted.
- [ ] Truncated/corrupt image → rejected cleanly (no crash).

## B. EXIF stripping

- [ ] Upload a JPEG containing GPS EXIF. After processing, download the stored object and confirm with `exiftool` (or `sharp().metadata()`) that NO GPS/EXIF remains.
- [ ] Confirm orientation is baked (image displays upright) since `.rotate()` is applied before metadata is dropped.

## C. Dimension + decompression-bomb protection

- [ ] Upload an image whose longest side > `MAX_DIMENSION` (12000px) → rejected.
- [ ] Upload an image > `MAX_PIXELS` (40MP) within side limits → rejected.
- [ ] Upload a known decompression bomb (e.g. a tiny PNG that decodes to a huge raster) → rejected on the pixels/byte gate; confirm the server does not OOM (note `limitInputPixels` handling).

## D. Thumbnail / derivative generation

- [ ] After approving a processed image, confirm a `*.thumb.webp` object exists at `buildThumbnailKey(storageKey)`.
- [ ] Confirm the thumbnail's longest edge == `THUMBNAIL_MAX_EDGE` (400) and aspect ratio matches the source.
- [ ] Confirm small images are NOT upscaled.
- [ ] Confirm the public gallery and profile card serve the thumbnail (signed URL), never the raw key.

## E. Finalize integration (flag on)

- [ ] With the flag ON, upload → finalize returns PENDING immediately (processing is out-of-band, not awaited).
- [ ] A processing rejection flips the item to REJECTED with a worker-visible reason, asynchronously.
- [ ] With the flag OFF, behavior is byte-for-byte the 5.5A flow (no processing, no thumbnail) — regression check.

## F. Cleanup / retention / deletion jobs

- [ ] Seed: one soft-deleted item, one REJECTED past the appeal window, one REMOVED past retention, one never-finalized UPLOADING past the orphan window, and one healthy APPROVED item.
- [ ] Run `npm run portfolio-cleanup`. Confirm: the first four are physically deleted (object + thumbnail) and their rows removed; the APPROVED item is untouched.
- [ ] Confirm `AuditLog` rows referencing deleted media still exist (audit preserved).
- [ ] Re-run the job immediately → idempotent, zero failures, nothing else deleted (missing objects don't error).
- [ ] Delete an object out-of-band, then run the job → still succeeds (idempotent delete).
- [ ] `purgeWorkerPortfolio(workerId)` removes all of a worker's objects+rows; re-run is a no-op.

## G. Security re-confirmation (still holds with 5.5B on)

- [ ] Public gallery / profile responses contain no `storageKey`, `thumbnailKey`, bucket name, presigned PUT URL, moderation note, admin ID, or reporter detail.
- [ ] Only APPROVED, non-deleted, non-removed media appears publicly.

## Record results

For each section, capture command output / screenshots and any deviations
in the delivery package's runtime-verification notes. Only when A–G all
pass should Phase 5.5B — and therefore Phase 5.5 — be marked complete.
