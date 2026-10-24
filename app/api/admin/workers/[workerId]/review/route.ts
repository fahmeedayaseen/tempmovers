import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { evaluateWorkerEligibility } from "@/lib/worker-eligibility";
import { queueNotification } from "@/lib/notifications";
import { workerAccountStatusTemplate } from "@/lib/email/templates/documents";

const schema = z.object({
  decision: z.enum(["APPROVE", "REJECT", "SUSPEND", "REACTIVATE"]),
  reason: z.string().min(1).optional(),
}).refine((data) => data.decision !== "REJECT" || !!data.reason, {
  message: "A reason is required to reject a worker.",
  path: ["reason"],
}).refine((data) => data.decision !== "SUSPEND" || !!data.reason, {
  message: "A reason is required to suspend a worker.",
  path: ["reason"],
});

/**
 * The only path that can move a worker to onboardingStatus COMPLETE /
 * operationalStatus ACTIVE — no automated or self-serve path exists.
 * Every decision is audited with the reviewing admin, timestamp, and
 * (for reject/suspend) a required reason.
 */
export async function POST(request: Request, context: { params: Promise<{ workerId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { workerId } = await context.params;

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const worker = await prisma.workerProfile.findUnique({ where: { id: workerId } });
  if (!worker) return NextResponse.json({ error: "Worker not found." }, { status: 404 });

  if (parsed.data.decision === "APPROVE" || parsed.data.decision === "REACTIVATE") {
    const evaluation = await evaluateWorkerEligibility({ workerId: worker.id, context: "ADMIN_APPROVAL" });
    if (!evaluation.allowed) {
      return NextResponse.json(
        { error: "Worker no longer meets approval requirements.", missing: evaluation.missingRequirements },
        { status: 409 },
      );
    }
  }

  let data: Parameters<typeof prisma.workerProfile.update>[0]["data"];
  let action: string;

  switch (parsed.data.decision) {
    case "APPROVE":
      data = { onboardingStatus: "COMPLETE", overallVerificationStatus: "APPROVED", operationalStatus: "ACTIVE", approvedAt: new Date(), rejectionReason: null };
      action = "WORKER_APPROVED";
      break;
    case "REJECT":
      data = { overallVerificationStatus: "REJECTED", operationalStatus: "RESTRICTED", rejectedAt: new Date(), rejectionReason: parsed.data.reason };
      action = "WORKER_REJECTED";
      break;
    case "SUSPEND":
      data = { operationalStatus: "SUSPENDED", overallVerificationStatus: "SUSPENDED", rejectionReason: parsed.data.reason };
      action = "WORKER_SUSPENDED";
      break;
    case "REACTIVATE":
      data = { operationalStatus: "ACTIVE", overallVerificationStatus: "APPROVED", rejectionReason: null };
      action = "WORKER_REACTIVATED";
      break;
  }

  const updated = await prisma.workerProfile.update({ where: { id: worker.id }, data });

  const audit = await prisma.auditLog.create({
    data: { actorId: authed.userId, action, entityType: "WorkerProfile", entityId: worker.id, details: { reason: parsed.data.reason ?? null } },
  });

  // Keyed off this specific audit log entry's own ID — stable across a
  // retry of this exact decision, but distinct from a later, genuinely
  // new decision of the same type (e.g. suspended, reactivated, then
  // suspended again shouldn't dedupe against the first suspension).
  const statusMap: Record<typeof action, "APPROVED" | "REJECTED" | "SUSPENDED" | "REACTIVATED"> = {
    WORKER_APPROVED: "APPROVED", WORKER_REJECTED: "REJECTED", WORKER_SUSPENDED: "SUSPENDED", WORKER_REACTIVATED: "REACTIVATED",
  };
  const notice = workerAccountStatusTemplate({ workerName: updated.displayName ?? "there", status: statusMap[action], reason: parsed.data.reason });
  await queueNotification({
    userId: updated.userId, type: "WORKER_ACCOUNT_STATUS", channels: ["EMAIL", "IN_APP"],
    title: notice.subject, body: notice.text, html: notice.html, idempotencyKey: `worker-status:${audit.id}`,
  });

  return NextResponse.json({ worker: updated });
}
