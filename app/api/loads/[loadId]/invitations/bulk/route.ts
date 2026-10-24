import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { inviteDriverToLoad, type InviteDriverResult } from "@/lib/loads/invite-driver";

/**
 * Bulk freight invitations (Phase 4) — invite several drivers to the
 * same load in one call. A separate route rather than an array-typed
 * workerId on the single POST: the single route's contract (one
 * invitation object back, 201/4xx/409 for the one failure reason) is
 * relied on by the Phase 3 single-invite UI and shouldn't change
 * shape under it. This route has an inherently different response
 * shape — a per-worker results array, since a batch of 10 invites can
 * legitimately be "7 sent, 2 already-invited-and-refreshed, 1 driver
 * inactive" all at once, none of which is a single HTTP status code.
 */
const MAX_BULK_WORKERS = 25;
const schema = z.object({
  workerIds: z.array(z.string().cuid()).min(1).max(MAX_BULK_WORKERS),
  expirationHours: z.number().min(0.25).max(72).optional(),
  templateId: z.string().cuid().optional(),
});

export async function POST(request: Request, context: { params: Promise<{ loadId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["CUSTOMER", "ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { loadId } = await context.params;

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const load = await prisma.carrierRoute.findUnique({ where: { id: loadId } });
  if (!load) return NextResponse.json({ error: "Load not found." }, { status: 404 });
  if (authed.role === "CUSTOMER" && load.postedByUserId !== authed.userId) {
    return NextResponse.json({ error: "Not your load." }, { status: 403 });
  }
  // Checked once here (not per-worker inside the loop): a closed load
  // means the whole batch fails identically, so there's no value in
  // 25 identical per-worker "load is no longer open" results.
  if (!["OPEN", "OFFER_RECEIVED"].includes(load.status)) {
    return NextResponse.json({ error: "Load is no longer open." }, { status: 409 });
  }

  let template: { subject: string; body: string } | undefined;
  if (parsed.data.templateId) {
    const row = await prisma.invitationTemplate.findUnique({ where: { id: parsed.data.templateId } });
    if (!row || row.ownerUserId !== authed.userId) {
      return NextResponse.json({ error: "Invitation template not found." }, { status: 404 });
    }
    template = { subject: row.subject, body: row.body };
  }

  // Sequential, not Promise.all — these are upserts against the same
  // load, and keeping them sequential means one worker's DB error
  // can't interleave with and obscure another's in the results array.
  // Batches are capped at MAX_BULK_WORKERS specifically so this stays
  // fast enough to run inline within one request.
  const results: InviteDriverResult[] = [];
  for (const workerId of parsed.data.workerIds) {
    results.push(await inviteDriverToLoad({ load, workerId, expirationHours: parsed.data.expirationHours, template }));
  }

  const succeeded = results.filter((r): r is Extract<InviteDriverResult, { ok: true }> => r.ok);
  if (succeeded.length > 0) {
    await prisma.auditLog.create({
      data: {
        actorId: authed.userId,
        action: "LOAD_INVITATION_BULK_SENT",
        entityType: "CarrierRoute",
        entityId: loadId,
        details: {
          loadId,
          templateId: parsed.data.templateId ?? null,
          requestedCount: parsed.data.workerIds.length,
          sentCount: succeeded.length,
          workerIds: succeeded.map((r) => r.workerId),
        },
      },
    });
  }

  return NextResponse.json({
    results,
    sentCount: succeeded.length,
    failedCount: results.length - succeeded.length,
  }, { status: 200 });
}
