import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { queueNotification } from "@/lib/notifications";
import { documentStatusTemplate } from "@/lib/email/templates/documents";
import { syncWorkerComplianceTracks } from "@/lib/compliance/sync-tracks";

const documentLabelByTrack = {
  IDENTITY: "Identity document", VEHICLE: "Vehicle registration", INSURANCE: "Certificate of insurance", DOT_MC: "Operating authority document",
} as const;

// A worker submits documents for one verification track at a time; an admin (or an
// automated checker, swapped in later) is what actually flips status to APPROVED.
const submitSchema = z.object({
  track: z.enum(["IDENTITY", "VEHICLE", "INSURANCE", "DOT_MC"]),
  // Holds a private S3 object key from the presign upload flow (see
  // POST /api/uploads/presign), not a URL — WorkerDocument.fileUrl is
  // resolved to a short-lived signed download URL only at access time via
  // GET /api/uploads/[documentId]/download, never stored or returned as a
  // directly-browsable link.
  documentUrl: z.string().min(1),
  expiresAt: z.string().datetime().optional(),
});

const decisionSchema = z.object({
  track: z.enum(["IDENTITY", "VEHICLE", "INSURANCE", "DOT_MC"]),
  decision: z.enum(["APPROVED", "REJECTED"]),
  reason: z.string().optional(),
});

const trackToField = {
  IDENTITY: "identityVerification",
  VEHICLE: "vehicleVerificationStatus",
  INSURANCE: "insuranceVerificationStatus",
  DOT_MC: "dotMcVerificationStatus",
} as const;

// Maps each verification track to the structured document type it produces —
// this is what was missing before: the route updated a status string but
// never actually persisted the submitted file anywhere.
const documentTypeByTrack = {
  IDENTITY: "DRIVERS_LICENSE",
  VEHICLE: "VEHICLE_REGISTRATION",
  INSURANCE: "CERTIFICATE_OF_INSURANCE",
  DOT_MC: "OPERATING_AUTHORITY",
} as const;

export async function POST(request: Request, context: { params: Promise<{ workerId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["MOVER", "DRIVER"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { workerId } = await context.params;
  const worker = await prisma.workerProfile.findUnique({ where: { id: workerId } });
  if (!worker || worker.userId !== authed.userId) {
    return NextResponse.json({ error: "Not your worker profile." }, { status: 403 });
  }

  const parsed = submitSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const field = trackToField[parsed.data.track];

  // Document creation, status update, and audit log all happen in one
  // transaction — a partial write (e.g. the document lands but the status
  // update fails) would leave the worker's onboarding progress
  // inconsistent with what was actually submitted.
  const result = await prisma.$transaction(async (tx) => {
    const document = await tx.workerDocument.create({
      data: {
        workerId,
        type: documentTypeByTrack[parsed.data.track],
        fileUrl: parsed.data.documentUrl,
        status: "PENDING",
        expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
      },
    });

    const updated = await tx.workerProfile.update({
      where: { id: workerId },
      data: { [field]: "IN_REVIEW" },
    });

    await tx.auditLog.create({
      data: {
        actorId: authed.userId, action: "VERIFICATION_SUBMITTED", entityType: "WorkerDocument", entityId: document.id,
        details: { workerId, track: parsed.data.track },
      },
    });

    return { document, worker: updated };
  });

  const submittedNotice = documentStatusTemplate({ workerName: result.worker.displayName ?? "there", documentLabel: documentLabelByTrack[parsed.data.track], status: "SUBMITTED" });
  await queueNotification({
    userId: authed.userId, type: "DOCUMENT_STATUS", channels: ["EMAIL", "IN_APP"],
    title: submittedNotice.subject, body: submittedNotice.text, html: submittedNotice.html, idempotencyKey: `document-submitted:${result.document.id}`,
  });

  await syncWorkerComplianceTracks(prisma, workerId);

  return NextResponse.json(result);
}

// Admin decision endpoint — approve or reject a specific verification track.
// Also updates the most recent matching WorkerDocument so the document's own
// review trail (reviewedAt/reviewedBy/status) stays in sync with the
// coarser WorkerProfile status field.
export async function PATCH(request: Request, context: { params: Promise<{ workerId: string }> }) {
  let admin;
  try {
    admin = await requireRole(request, ["ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { workerId } = await context.params;
  const parsed = decisionSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const field = trackToField[parsed.data.track];
  const documentType = documentTypeByTrack[parsed.data.track];

  const result = await prisma.$transaction(async (tx) => {
    const updated = await tx.workerProfile.update({
      where: { id: workerId },
      data: { [field]: parsed.data.decision },
    });

    const latestDoc = await tx.workerDocument.findFirst({
      where: { workerId, type: documentType, status: "PENDING" },
      orderBy: { submittedAt: "desc" },
    });
    if (latestDoc) {
      await tx.workerDocument.update({
        where: { id: latestDoc.id },
        data: {
          status: parsed.data.decision === "APPROVED" ? "APPROVED" : "REJECTED",
          reviewedAt: new Date(), reviewedBy: admin.userId, reason: parsed.data.reason,
        },
      });
    }

    await tx.auditLog.create({
      data: { actorId: admin.userId, action: `VERIFICATION_${parsed.data.decision}`, entityType: "WorkerProfile", entityId: workerId, details: parsed.data },
    });

    return { worker: updated, documentId: latestDoc?.id ?? null };
  });

  const decisionNotice = documentStatusTemplate({
    workerName: result.worker.displayName ?? "there", documentLabel: documentLabelByTrack[parsed.data.track],
    status: parsed.data.decision === "APPROVED" ? "APPROVED" : "REJECTED", reason: parsed.data.reason,
  });
  // Keyed off the specific document being decided on (stable across a
  // retry of this same decision) rather than a timestamp — the same
  // mistake as the Stripe checkout idempotency bug fixed earlier in this
  // build would defeat the whole point of the idempotency key.
  await queueNotification({
    userId: result.worker.userId, type: "DOCUMENT_STATUS", channels: ["EMAIL", "IN_APP"],
    title: decisionNotice.subject, body: decisionNotice.text, html: decisionNotice.html,
    idempotencyKey: `document-${parsed.data.decision.toLowerCase()}:${result.documentId ?? workerId}:${parsed.data.track}`,
  });

  await syncWorkerComplianceTracks(prisma, workerId);

  return NextResponse.json({ worker: result.worker });
}
