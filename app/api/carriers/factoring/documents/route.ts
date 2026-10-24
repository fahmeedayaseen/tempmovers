import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { createUploadUrl, createDownloadUrl } from "@/lib/storage";

/**
 * Factoring documents (gap contract #8) — NOA / Release / Remittance. Separate
 * from carrier documents because these are FactoringDocument records with their
 * own type enum. Same secure pattern: presign POST → client PUT to private
 * storage → finalize PATCH; download GET returns a short-lived signed link.
 * Carrier-scoped by ownerUserId; the client never sees a permanent storage URL.
 */
const FACTORING_DOC_TYPES = ["NOTICE_OF_ASSIGNMENT", "RELEASE_OF_ASSIGNMENT", "REMITTANCE_INSTRUCTIONS", "OTHER"] as const;

async function resolveCarrierId(userId: string): Promise<string | null> {
  const c = await prisma.carrier.findUnique({ where: { ownerUserId: userId }, select: { id: true } });
  return c?.id ?? null;
}

const presignSchema = z.object({
  documentType: z.enum(FACTORING_DOC_TYPES),
  originalFileName: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(120),
  fileSize: z.number().int().positive().max(50 * 1024 * 1024),
});

export async function POST(request: Request) {
  let authed;
  try { authed = await requireRole(request, ["CARRIER", "ADMIN", "SUPER_ADMIN"] as unknown as ("ADMIN")[]); }
  catch (e) { if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; }
  const carrierId = await resolveCarrierId(authed.userId);
  if (!carrierId) return NextResponse.json({ error: "No carrier profile." }, { status: 404 });
  const parsed = presignSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const ext = parsed.data.originalFileName.split(".").pop() ?? "bin";
  const key = `carriers/${carrierId}/factoring/${parsed.data.documentType}/${Date.now()}.${ext}`;
  const uploadUrl = await createUploadUrl({ key, contentType: parsed.data.mimeType, contentLength: parsed.data.fileSize });
  return NextResponse.json({ uploadUrl, storageReference: key });
}

const finalizeSchema = z.object({
  documentType: z.enum(FACTORING_DOC_TYPES),
  storageReference: z.string().min(1),
  originalFileName: z.string().min(1).max(255),
  effectiveAt: z.string().datetime().optional(),
  expiresAt: z.string().datetime().optional(),
});

export async function PATCH(request: Request) {
  let authed;
  try { authed = await requireRole(request, ["CARRIER", "ADMIN", "SUPER_ADMIN"] as unknown as ("ADMIN")[]); }
  catch (e) { if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; }
  const carrierId = await resolveCarrierId(authed.userId);
  if (!carrierId) return NextResponse.json({ error: "No carrier profile." }, { status: 404 });
  const parsed = finalizeSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  // Storage key must belong to this carrier (defense in depth).
  if (!parsed.data.storageReference.startsWith(`carriers/${carrierId}/factoring/`)) {
    return NextResponse.json({ error: "Invalid storage reference." }, { status: 400 });
  }
  const d = parsed.data;
  const document = await prisma.factoringDocument.create({
    data: { carrierId, type: d.documentType, storageKey: d.storageReference, fileName: d.originalFileName, uploadedById: authed.userId,
      effectiveAt: d.effectiveAt ? new Date(d.effectiveAt) : undefined, expiresAt: d.expiresAt ? new Date(d.expiresAt) : undefined },
  });
  return NextResponse.json({ document }, { status: 201 });
}

export async function GET(request: Request) {
  let authed;
  try { authed = await requireRole(request, ["CARRIER", "ADMIN", "SUPER_ADMIN"] as unknown as ("ADMIN")[]); }
  catch (e) { if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; }
  const carrierId = await resolveCarrierId(authed.userId);
  if (!carrierId) return NextResponse.json({ error: "No carrier profile." }, { status: 404 });
  const url = new URL(request.url);
  const documentId = url.searchParams.get("documentId");
  if (documentId) {
    const doc = await prisma.factoringDocument.findUnique({ where: { id: documentId }, select: { carrierId: true, storageKey: true } });
    if (!doc || doc.carrierId !== carrierId) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const downloadUrl = await createDownloadUrl(doc.storageKey);
    return NextResponse.json({ downloadUrl });
  }
  const documents = await prisma.factoringDocument.findMany({ where: { carrierId }, orderBy: { createdAt: "desc" } });
  return NextResponse.json({ documents });
}
