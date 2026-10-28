import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { createUploadUrl, StorageNotConfiguredError } from "@/lib/storage";
import { buildJunkBookingPhotoKey, buildJunkProofKey, JUNK_PROOF_KINDS, JUNK_UPLOAD_CONTENT_TYPES } from "@/lib/junk/storage-keys";

/**
 * Junk removal — VASRUE Digital Media, 28 October 2026.
 *
 * Signed upload URLs for junk photos, through the same private storage as
 * worker documents (lib/storage.ts): the file goes straight from the browser
 * to the bucket, and only the object key comes back here.
 *   - BOOKING_PHOTO: a customer's photos of what is to be hauled (spec §4).
 *   - BEFORE / AFTER / DUMP_RECEIPT: the crew's proof of service and of
 *     proper disposal (spec §7). Only a worker holding a seat on that job.
 * The key is then attached with POST /api/junk/bookings (customer) or
 * POST /api/junk/assignments/[assignmentId]/proof (crew), both of which
 * check it was issued for that customer or job.
 */
const schema = z.object({
  purpose: z.enum(["BOOKING_PHOTO", ...JUNK_PROOF_KINDS]),
  assignmentId: z.string().optional(),
  contentType: z.enum(JUNK_UPLOAD_CONTENT_TYPES),
  contentLength: z.number().int().positive(),
});

export async function POST(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["CUSTOMER", "MOVER", "DRIVER"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const { purpose, assignmentId, contentType, contentLength } = parsed.data;

  let key: string;
  if (purpose === "BOOKING_PHOTO") {
    if (authed.role !== "CUSTOMER") return NextResponse.json({ error: "Only customers add booking photos." }, { status: 403 });
    if (contentType === "application/pdf") return NextResponse.json({ error: "Booking photos must be images." }, { status: 400 });
    const customer = await prisma.customerProfile.findUnique({ where: { userId: authed.userId }, select: { id: true } });
    if (!customer) return NextResponse.json({ error: "No customer profile for this account." }, { status: 403 });
    key = buildJunkBookingPhotoKey(customer.id, contentType);
  } else {
    if (authed.role === "CUSTOMER") return NextResponse.json({ error: "Only the crew adds proof of service." }, { status: 403 });
    if (!assignmentId) return NextResponse.json({ error: "assignmentId is required for proof uploads." }, { status: 400 });
    const assignment = await prisma.assignment.findUnique({ where: { id: assignmentId }, select: { jobId: true, junkCrewRole: true, worker: { select: { userId: true } } } });
    if (!assignment || assignment.worker.userId !== authed.userId) return NextResponse.json({ error: "Not your assignment." }, { status: 403 });
    if (!assignment.junkCrewRole) return NextResponse.json({ error: "Proof uploads are for junk removal jobs." }, { status: 409 });
    key = buildJunkProofKey(assignment.jobId, purpose, contentType);
  }

  try {
    const uploadUrl = await createUploadUrl({ key, contentType, contentLength });
    return NextResponse.json({ uploadUrl, key, contentType });
  } catch (e) {
    if (e instanceof StorageNotConfiguredError) {
      return NextResponse.json({ error: "Photo uploads aren't switched on yet.", code: "STORAGE_NOT_CONFIGURED" }, { status: 503 });
    }
    if (e instanceof Error && /not allowed|exceeds/.test(e.message)) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
