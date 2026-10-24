import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { createUploadUrl, createDownloadUrl } from "@/lib/storage";

/**
 * Carrier document upload + secure download (launch spec §1).
 *
 * Two-step upload: POST returns a presigned PUT url (private bucket); the
 * client PUTs the file to storage directly; PATCH finalizes the metadata row.
 * Files are PRIVATE by default — downloads are served ONLY through short-lived
 * signed links (GET), never a public storage URL.
 *
 * Access control: a carrier may only touch its OWN documents; admins may
 * access any for review.
 */
const DOC_TYPES = ["W9", "CERTIFICATE_OF_INSURANCE", "AUTHORITY_LETTER", "CARRIER_AGREEMENT", "OTHER"] as const;

async function resolveCarrier(userId: string, role: string, carrierIdParam?: string | null) {
  if (["ADMIN", "SUPPORT", "FINANCE_ADMIN", "SUPER_ADMIN"].includes(role) && carrierIdParam) {
    return prisma.carrier.findUnique({ where: { id: carrierIdParam } });
  }
  return prisma.carrier.findUnique({ where: { ownerUserId: userId } });
}

// Step 1: request a presigned upload URL.
const presignSchema = z.object({
  documentType: z.enum(DOC_TYPES),
  originalFileName: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(120),
  fileSize: z.number().int().positive().max(50 * 1024 * 1024), // 50MB cap
});

export async function POST(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["CARRIER", "ADMIN", "SUPER_ADMIN"] as unknown as ("ADMIN")[]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const parsed = presignSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const carrier = await resolveCarrier(authed.userId, authed.role);
  if (!carrier) return NextResponse.json({ error: "No carrier profile." }, { status: 404 });

  const ext = parsed.data.originalFileName.split(".").pop() ?? "bin";
  const key = `carriers/${carrier.id}/documents/${parsed.data.documentType}/${Date.now()}.${ext}`;
  const uploadUrl = await createUploadUrl({ key, contentType: parsed.data.mimeType, contentLength: parsed.data.fileSize });

  return NextResponse.json({ uploadUrl, storageReference: key });
}

// Step 2: finalize the metadata after the client PUTs the file.
const finalizeSchema = z.object({
  documentType: z.enum(DOC_TYPES),
  storageReference: z.string().min(1),
  originalFileName: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(120),
  fileSize: z.number().int().positive(),
  effectiveAt: z.string().datetime().optional(),
  expiresAt: z.string().datetime().optional(),
});

export async function PATCH(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["CARRIER", "ADMIN", "SUPER_ADMIN"] as unknown as ("ADMIN")[]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const parsed = finalizeSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const carrier = await resolveCarrier(authed.userId, authed.role);
  if (!carrier) return NextResponse.json({ error: "No carrier profile." }, { status: 404 });
  // Ownership: the storage key must belong to this carrier.
  if (!parsed.data.storageReference.startsWith(`carriers/${carrier.id}/`)) {
    return NextResponse.json({ error: "Storage reference does not belong to this carrier." }, { status: 403 });
  }

  const doc = await prisma.carrierDocument.create({
    data: {
      carrierId: carrier.id,
      type: parsed.data.documentType,
      storageKey: parsed.data.storageReference,
      fileName: parsed.data.originalFileName,
      uploadedById: authed.userId,
      expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
      verified: false,
    },
  });
  return NextResponse.json({ document: doc }, { status: 201 });
}

// Secure download: returns a short-lived signed URL, never a public URL.
export async function GET(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["CARRIER", "ADMIN", "SUPPORT", "FINANCE_ADMIN", "SUPER_ADMIN"] as unknown as ("ADMIN")[]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const url = new URL(request.url);
  const documentId = url.searchParams.get("documentId");
  if (!documentId) return NextResponse.json({ error: "documentId is required." }, { status: 400 });

  const doc = await prisma.carrierDocument.findUnique({ where: { id: documentId }, include: { carrier: { select: { ownerUserId: true } } } });
  if (!doc) return NextResponse.json({ error: "Document not found." }, { status: 404 });

  const isAdmin = ["ADMIN", "SUPPORT", "FINANCE_ADMIN", "SUPER_ADMIN"].includes(authed.role);
  if (!isAdmin && doc.carrier.ownerUserId !== authed.userId) {
    return NextResponse.json({ error: "Not authorized to access this document." }, { status: 403 });
  }

  const downloadUrl = await createDownloadUrl(doc.storageKey); // short-lived signed link
  return NextResponse.json({ downloadUrl });
}
