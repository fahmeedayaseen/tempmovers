import { NextResponse } from "next/server";
import { z } from "zod";
import { requireRole, AuthError } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { buildSettlementPreview } from "@/lib/settlements/preview";
import { computeBatchFingerprint, issuePreviewToken } from "@/lib/settlements/preview-token";

/**
 * Settlement PREVIEW (handoff Option 3, steps 5–6). Returns the eligible /
 * skipped summary for a worker+period WITHOUT settling anything — the admin
 * reviews this, then calls POST /api/settlements with confirm:true to execute.
 * Read-only; authorization is applied per load via the shared preview builder.
 */
const schema = z.object({
  workerId: z.string().cuid(),
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime(),
});
const MAX_PERIOD_DAYS = 45;

export async function POST(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["ADMIN", "FINANCE_ADMIN", "SUPER_ADMIN"] as unknown as ("ADMIN")[]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const periodStart = new Date(parsed.data.periodStart);
  const periodEnd = new Date(parsed.data.periodEnd);
  if (periodEnd <= periodStart) return NextResponse.json({ error: "`periodEnd` must be after `periodStart`." }, { status: 400 });
  if ((periodEnd.getTime() - periodStart.getTime()) / 86_400_000 > MAX_PERIOD_DAYS) {
    return NextResponse.json({ error: `Settlement period cannot exceed ${MAX_PERIOD_DAYS} days.` }, { status: 400 });
  }

  const worker = await prisma.workerProfile.findUnique({ where: { id: parsed.data.workerId }, select: { id: true } });
  if (!worker) return NextResponse.json({ error: "Worker not found." }, { status: 404 });

  const preview = await buildSettlementPreview({ userId: authed.userId, workerId: worker.id, periodStart, periodEnd });

  // Bind a confirmation to THIS batch: fingerprint the eligible+skipped loads
  // and embed it in a short-lived signed token. Execution rejects if the data
  // changed or the token expired.
  const fingerprint = computeBatchFingerprint({
    workerId: worker.id,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    eligible: preview.fingerprintLoads,
    skippedLoadIds: preview.skippedLoadIds,
  });
  const previewToken = await issuePreviewToken({ userId: authed.userId, workerId: worker.id, periodStart: periodStart.toISOString(), periodEnd: periodEnd.toISOString(), fingerprint });

  // Preview is auditable too (the doc wants audit for both preview and exec).
  await prisma.auditLog.create({
    data: { actorId: authed.userId, action: "SETTLEMENT_PREVIEWED", entityType: "WorkerProfile", entityId: worker.id,
      details: { periodStart, periodEnd, eligibleCount: preview.eligibleCount, skippedCount: preview.skippedCount, skippedMarkets: preview.skippedMarkets } },
  });

  // Don't leak the internal fingerprint projection to the client.
  const { fingerprintLoads, ...clientPreview } = preview;
  return NextResponse.json({ preview: clientPreview, previewToken, confirmationRequired: true });
}
