import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export class StorageNotConfiguredError extends Error {
  constructor() {
    super("AWS_S3_BUCKET / AWS_REGION are not configured.");
  }
}

function client() {
  const region = process.env.AWS_REGION;
  if (!region) throw new StorageNotConfiguredError();
  return new S3Client({ region });
}

function bucket() {
  const b = process.env.AWS_S3_BUCKET;
  if (!b) throw new StorageNotConfiguredError();
  return b;
}

const ALLOWED_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "application/pdf"]);
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // 15MB

/**
 * Presigned PUT URL for a direct-to-S3 upload. The object key (not a public
 * URL) is what gets stored in WorkerDocument.fileUrl — the object itself is
 * never public, so "fileUrl" is a slight misnomer kept for schema
 * compatibility with the existing WorkerDocument.fileUrl column; it holds
 * a private key, resolved to a signed URL only at download time.
 */
export async function createUploadUrl({ key, contentType, contentLength }: { key: string; contentType: string; contentLength: number }) {
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    throw new Error(`Content type ${contentType} is not allowed for document uploads.`);
  }
  if (contentLength > MAX_UPLOAD_BYTES) {
    throw new Error(`File exceeds the ${MAX_UPLOAD_BYTES / 1024 / 1024}MB limit.`);
  }

  const command = new PutObjectCommand({
    Bucket: bucket(),
    Key: key,
    ContentType: contentType,
    ServerSideEncryption: "aws:kms",
    SSEKMSKeyId: process.env.AWS_S3_KMS_KEY_ID,
  });

  return getSignedUrl(client(), command, { expiresIn: 300 });
}

/** Short-lived signed GET URL — documents are never served from a public bucket. */
export async function createDownloadUrl(key: string) {
  const command = new GetObjectCommand({ Bucket: bucket(), Key: key });
  return getSignedUrl(client(), command, { expiresIn: 300 });
}

/** Deterministic, collision-resistant key scoped to the worker and document type. */
export function buildDocumentKey({ workerId, documentType, fileExtension }: { workerId: string; documentType: string; fileExtension: string }) {
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 10);
  return `worker-documents/${workerId}/${documentType.toLowerCase()}/${timestamp}-${random}.${fileExtension}`;
}

// ===== Phase 5.5 — portfolio media storage helpers =====

const PORTFOLIO_ALLOWED_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const PORTFOLIO_MAX_BYTES = 10 * 1024 * 1024; // 10MB per spec (configurable)

/**
 * Random, NON-guessable portfolio object key. Per the spec, keys must not
 * be derived only from the original filename — the random segment is the
 * whole point, so a leaked key can't be guessed from a worker's other keys.
 * Kept under a private prefix; the object is never in a public bucket.
 */
export function buildPortfolioKey({ workerId, fileExtension }: { workerId: string; fileExtension: string }) {
  const random = `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  return `portfolio-media/${workerId}/${random}.${fileExtension}`;
}

/** Presigned PUT for a portfolio image. Tighter allow-list than documents (no HEIC/PDF). */
export async function createPortfolioUploadUrl({ key, contentType, contentLength }: { key: string; contentType: string; contentLength: number }) {
  if (!PORTFOLIO_ALLOWED_CONTENT_TYPES.has(contentType)) {
    throw new Error(`Content type ${contentType} is not allowed for portfolio uploads.`);
  }
  if (contentLength > PORTFOLIO_MAX_BYTES) {
    throw new Error(`Image exceeds the ${PORTFOLIO_MAX_BYTES / 1024 / 1024}MB limit.`);
  }
  const command = new PutObjectCommand({
    Bucket: bucket(),
    Key: key,
    ContentType: contentType,
    ServerSideEncryption: "aws:kms",
    SSEKMSKeyId: process.env.AWS_S3_KMS_KEY_ID,
  });
  return getSignedUrl(client(), command, { expiresIn: 300 });
}

/**
 * Confirm an uploaded object actually exists and read back its
 * server-recorded size/type — used by finalize to verify the client
 * really uploaded what it claimed before the item enters moderation.
 * Returns null when the object is absent (finalize then 409s).
 */
export async function headObject(key: string): Promise<{ contentLength: number; contentType: string | undefined } | null> {
  try {
    const res = await client().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
    return { contentLength: res.ContentLength ?? 0, contentType: res.ContentType };
  } catch {
    return null;
  }
}

/** Idempotent, retry-safe delete — a missing object resolves successfully so a cleanup batch never fails on an already-gone key. */
export async function deleteObject(key: string): Promise<void> {
  try {
    await client().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
  } catch (e) {
    // A 404/NoSuchKey is success for cleanup purposes; only rethrow on
    // genuinely unexpected errors so retry-safe batches keep going.
    const name = (e as { name?: string })?.name ?? "";
    if (name.includes("NotFound") || name.includes("NoSuchKey")) return;
    throw e;
  }
}

// ===== Phase 5.5B — server-side object read/write for image processing =====
// UNVERIFIED IN THIS ENVIRONMENT. These stream the actual object bytes to the
// server so sharp can inspect/transform them. They require a real bucket and
// have never been executed here — treat as "should work given the code."

/**
 * Read a full object's bytes into a Buffer, server-side, for image
 * processing (magic-byte check, EXIF strip, thumbnail source). Only ever
 * called by trusted server code on the worker's own uploaded object.
 * Bounded by the upload size limits enforced at presign/finalize.
 */
export async function getObjectBytes(key: string): Promise<Buffer> {
  const res = await client().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  const body = res.Body as unknown as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
  if (!body?.transformToByteArray) throw new Error("Unexpected empty object body.");
  return Buffer.from(await body.transformToByteArray());
}

/**
 * Write bytes to a key (e.g. a generated thumbnail or a re-encoded,
 * EXIF-stripped derivative), with the same KMS encryption as uploads.
 */
export async function putObjectBytes({ key, contentType, body }: { key: string; contentType: string; body: Buffer }): Promise<void> {
  await client().send(new PutObjectCommand({
    Bucket: bucket(),
    Key: key,
    Body: body,
    ContentType: contentType,
    ServerSideEncryption: "aws:kms",
    SSEKMSKeyId: process.env.AWS_S3_KMS_KEY_ID,
  }));
}

/** Derives the thumbnail key for a given source portfolio key. Deterministic so a retried job overwrites rather than duplicates. */
export function buildThumbnailKey(sourceKey: string): string {
  // portfolio-media/<worker>/<rand>.<ext>  ->  portfolio-media/<worker>/<rand>.thumb.webp
  return sourceKey.replace(/\.([a-z0-9]+)$/i, ".thumb.webp");
}
