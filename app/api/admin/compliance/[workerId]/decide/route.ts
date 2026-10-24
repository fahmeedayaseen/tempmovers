import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { queueNotification } from "@/lib/notifications";
import { workerAccountStatusTemplate } from "@/lib/email/templates/documents";

const schema = z.object({
  decision: z.enum(["APPROVE", "RESTRICT", "SUSPEND", "REACTIVATE"]),
  reason: z.string().optional(),
}).refine((d) => d.decision === "APPROVE" || d.decision === "REACTIVATE" || !!d.reason, {
  message: "A reason is required to restrict or suspend a worker's compliance status.",
  path: ["reason"],
});

/**
 * Sets WorkerCompliance.adminApprovalStatus — the final gate
 * checkOpportunityAccess() reads via complianceApproved. This is
 * deliberately a separate, explicit admin action from the individual
 * credential-track decisions (identity/background/license/etc, still
 * handled by PATCH /api/workers/[workerId]/verification) — an admin can
 * see every individual track pass and still choose not to grant overall
 * approval, or revoke it later without touching the individual tracks.
 */
export async function POST(request: Request, context: { params: Promise<{ workerId: string }> }) {
  let admin;
  try {
    admin = await requireRole(request, ["ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { workerId } = await context.params;
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const worker = await prisma.workerProfile.findUnique({ where: { id: workerId } });
  if (!worker) return NextResponse.json({ error: "Worker not found." }, { status: 404 });

  const statusMap = { APPROVE: "APPROVED", RESTRICT: "RESTRICTED", SUSPEND: "SUSPENDED", REACTIVATE: "APPROVED" } as const;
  const adminApprovalStatus = statusMap[parsed.data.decision];

  const compliance = await prisma.workerCompliance.upsert({
    where: { workerId },
    update: {
      adminApprovalStatus,
      ...(parsed.data.decision === "APPROVE" || parsed.data.decision === "REACTIVATE" ? { approvedAt: new Date() } : {}),
      ...(parsed.data.decision === "RESTRICT" || parsed.data.decision === "SUSPEND" ? { restrictedAt: new Date(), restrictionReason: parsed.data.reason } : {}),
    },
    create: {
      workerId, adminApprovalStatus,
      ...(parsed.data.decision === "APPROVE" && { approvedAt: new Date() }),
      ...(parsed.data.decision === "RESTRICT" && { restrictedAt: new Date(), restrictionReason: parsed.data.reason }),
    },
  });

  const audit = await prisma.auditLog.create({
    data: { actorId: admin.userId, action: `COMPLIANCE_${parsed.data.decision}`, entityType: "WorkerCompliance", entityId: compliance.id, details: { workerId, reason: parsed.data.reason ?? null } },
  });

  // Previously missing entirely: the worker was never told about a
  // background-check-specific compliance decision, even though this is
  // frequently the actual final gate (onboarding can be approved while
  // the background check is still pending review, or vice versa).
  const notificationStatusMap = { APPROVE: "APPROVED", RESTRICT: "RESTRICTED", SUSPEND: "SUSPENDED", REACTIVATE: "REACTIVATED" } as const;
  const notice = workerAccountStatusTemplate({ workerName: worker.displayName ?? "there", status: notificationStatusMap[parsed.data.decision], reason: parsed.data.reason });
  await queueNotification({
    userId: worker.userId, type: "WORKER_ACCOUNT_STATUS", channels: ["EMAIL", "IN_APP"],
    // Keyed off this specific audit log entry's own ID — stable across a
    // retry of this exact decision, but distinct from a later, genuinely
    // new decision of the same type. compliance.id would NOT work here:
    // it's the same upserted WorkerCompliance row across a worker's
    // entire history, so restricted -> reactivated -> restricted again
    // (a different, later restriction) would collide on the same key as
    // the first restriction and silently never send the second notice.
    title: notice.subject, body: notice.text, html: notice.html, idempotencyKey: `compliance-status:${audit.id}`,
  });

  return NextResponse.json({ compliance });
}
