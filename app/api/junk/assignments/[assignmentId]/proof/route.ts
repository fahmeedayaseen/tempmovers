import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { headObject } from "@/lib/storage";
import { isKeyUnder, JUNK_PROOF_KINDS, junkProofPrefix, MAX_JUNK_PHOTOS_PER_SET } from "@/lib/junk/storage-keys";

/**
 * Junk removal — VASRUE Digital Media, 28 October 2026.
 *
 * Records the crew's proof on a junk job (Carl's junk spec §7): before and
 * after photos, and the dump receipt as proof of proper disposal.
 *
 * 29 Oct 2026, pay before dispatch: proof is now tied to pay. Before and after
 * photos are required evidence before a junk job settles, and the dump
 * receipt is what the hauler's disposal reimbursement is paid against (and
 * what any unused disposal refund to the customer is worked out from). The
 * amount itself is entered through POST .../disposal.
 *
 * The key must have been issued by POST /api/junk/uploads/presign for this
 * job and this kind, and the object must actually exist in the bucket.
 */
const schema = z.object({ kind: z.enum(JUNK_PROOF_KINDS), key: z.string().max(300) });

export async function POST(request: Request, context: { params: Promise<{ assignmentId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["MOVER", "DRIVER"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { assignmentId } = await context.params;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const { kind, key } = parsed.data;

  const assignment = await prisma.assignment.findUnique({
    where: { id: assignmentId },
    select: { jobId: true, status: true, junkCrewRole: true, worker: { select: { userId: true } } },
  });
  if (!assignment || assignment.worker.userId !== authed.userId) return NextResponse.json({ error: "Not your assignment." }, { status: 403 });
  if (!assignment.junkCrewRole) return NextResponse.json({ error: "Proof is recorded on junk removal jobs only." }, { status: 409 });
  if (!["CHECKED_IN", "CHECKED_OUT", "APPROVED"].includes(assignment.status)) {
    return NextResponse.json({ error: "Check in on the job before adding proof." }, { status: 409 });
  }
  if (!isKeyUnder(key, junkProofPrefix(assignment.jobId, kind))) {
    return NextResponse.json({ error: "That file was not uploaded for this job." }, { status: 400 });
  }

  // headObject() reports every failure as "not found", including storage not
  // being configured at all, so that case is checked first and named plainly.
  if (!process.env.AWS_REGION || !process.env.AWS_S3_BUCKET) {
    return NextResponse.json({ error: "Photo uploads aren't switched on yet.", code: "STORAGE_NOT_CONFIGURED" }, { status: 503 });
  }
  const head = await headObject(key);
  if (!head) return NextResponse.json({ error: "The upload has not finished. Try again in a moment." }, { status: 409 });

  const detail = await prisma.junkRemovalDetail.findUnique({ where: { jobId: assignment.jobId }, select: { beforePhotoKeys: true, afterPhotoKeys: true } });
  if (!detail) return NextResponse.json({ error: "This junk removal job is missing its details." }, { status: 409 });

  if (kind === "DUMP_RECEIPT") {
    await prisma.junkRemovalDetail.update({ where: { jobId: assignment.jobId }, data: { dumpReceiptKey: key } });
  } else {
    const current = kind === "BEFORE" ? detail.beforePhotoKeys : detail.afterPhotoKeys;
    if (current.length >= MAX_JUNK_PHOTOS_PER_SET) {
      return NextResponse.json({ error: `Up to ${MAX_JUNK_PHOTOS_PER_SET} ${kind.toLowerCase()} photos per job.` }, { status: 409 });
    }
    await prisma.junkRemovalDetail.update({
      where: { jobId: assignment.jobId },
      data: kind === "BEFORE" ? { beforePhotoKeys: { push: key } } : { afterPhotoKeys: { push: key } },
    });
  }

  await prisma.auditLog.create({
    data: { actorId: authed.userId, action: "JUNK_PROOF_ADDED", entityType: "Job", entityId: assignment.jobId, details: { kind, assignmentId } },
  });
  return NextResponse.json({ recorded: kind }, { status: 201 });
}
