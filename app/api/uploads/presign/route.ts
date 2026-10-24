import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { createUploadUrl, buildDocumentKey, StorageNotConfiguredError } from "@/lib/storage";

const schema = z.object({
  documentType: z.enum(["DRIVERS_LICENSE", "CDL", "MEDICAL_CARD", "VEHICLE_REGISTRATION", "VEHICLE_PHOTO", "CERTIFICATE_OF_INSURANCE", "W9", "OPERATING_AUTHORITY", "PROFILE_PHOTO", "OTHER"]),
  contentType: z.enum(["image/jpeg", "image/png", "image/webp", "image/heic", "application/pdf"]),
  contentLength: z.number().int().positive(),
});

const EXTENSION_BY_TYPE: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic", "application/pdf": "pdf",
};

/**
 * Replaces the "paste a URL" placeholder the onboarding forms used before
 * private storage existed. Returns a short-lived signed PUT URL and the
 * object key — the actual file bytes go directly from the client to S3,
 * never through this server. Deliberately does NOT create the
 * WorkerDocument row itself: the frontend calls
 * POST /api/workers/[workerId]/verification with the returned key as
 * `documentUrl` once the upload completes, which is what actually
 * persists the document — keeping document creation in one place instead
 * of two routes racing to create it.
 */
export async function POST(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["MOVER", "DRIVER"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const worker = await prisma.workerProfile.findUnique({ where: { userId: authed.userId } });
  if (!worker) return NextResponse.json({ error: "Worker profile not found." }, { status: 404 });

  const key = buildDocumentKey({ workerId: worker.id, documentType: parsed.data.documentType, fileExtension: EXTENSION_BY_TYPE[parsed.data.contentType] });

  let uploadUrl: string;
  try {
    uploadUrl = await createUploadUrl({ key, contentType: parsed.data.contentType, contentLength: parsed.data.contentLength });
  } catch (e) {
    if (e instanceof StorageNotConfiguredError) return NextResponse.json({ error: e.message }, { status: 500 });
    throw e;
  }

  return NextResponse.json({ uploadUrl, key, contentType: parsed.data.contentType });
}
