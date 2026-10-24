import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { prisma } from "@/lib/db";
import { captureIntegrationAlert } from "@/lib/monitoring";
import { syncWorkerComplianceTracks } from "@/lib/compliance/sync-tracks";

/**
 * Records source-verified policy data and — unlike the Checkr background
 * check webhook — DOES automatically restrict a worker on a coverage
 * lapse or cancellation. This is the one case in this integration set
 * where automatic restriction is appropriate: an insurance lapse is an
 * objective, source-verified fact (the policy is or isn't active), not a
 * judgment call requiring an FCRA-style adverse-action process. Admins
 * can still manually override with an audited reason via the existing
 * admin worker-review endpoint.
 */
export async function POST(request: Request) {
  const secret = process.env.CERTIFICIAL_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: "Webhook not configured." }, { status: 500 });

  const payload = await request.text();
  const signature = request.headers.get("x-certificial-signature");
  if (!signature) return NextResponse.json({ error: "Missing signature." }, { status: 400 });

  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (signatureBuffer.length !== expectedBuffer.length || !timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return NextResponse.json({ error: "Invalid signature." }, { status: 400 });
  }

  const event = JSON.parse(payload);
  const workerId: string | undefined = event.external_reference;
  const policyStatus: string | undefined = event.status;
  if (!workerId) return NextResponse.json({ received: true });

  const worker = await prisma.workerProfile.findUnique({ where: { id: workerId } });
  if (!worker) {
    captureIntegrationAlert("Certificial webhook for unknown worker.", { area: "insurance", workerId });
    return NextResponse.json({ received: true });
  }

  await prisma.insurancePolicy.upsert({
    where: { id: event.policy_id ?? `certificial-${workerId}` },
    update: {
      status: policyStatus ?? "UNKNOWN", carrierName: event.carrier_name, policyNumber: event.policy_number,
      limitCents: event.limit_cents, effectiveAt: event.effective_at ? new Date(event.effective_at) : undefined,
      expiresAt: event.expires_at ? new Date(event.expires_at) : undefined, rawResponse: event,
    },
    create: {
      id: event.policy_id ?? `certificial-${workerId}`,
      workerId, provider: "CERTIFICIAL", externalPolicyId: event.policy_id, policyType: event.policy_type ?? "COMMERCIAL_AUTO",
      status: policyStatus ?? "UNKNOWN", carrierName: event.carrier_name, policyNumber: event.policy_number,
      limitCents: event.limit_cents, effectiveAt: event.effective_at ? new Date(event.effective_at) : undefined,
      expiresAt: event.expires_at ? new Date(event.expires_at) : undefined, rawResponse: event,
    },
  });

  if (policyStatus === "LAPSED" || policyStatus === "CANCELLED" || policyStatus === "EXPIRED") {
    if (worker.operationalStatus === "ACTIVE") {
      await prisma.workerProfile.update({ where: { id: workerId }, data: { operationalStatus: "RESTRICTED", insuranceVerificationStatus: "REJECTED" } });
      await prisma.auditLog.create({
        data: { action: "WORKER_RESTRICTED_INSURANCE_LAPSE", entityType: "WorkerProfile", entityId: workerId, details: { policyStatus } },
      });
    }
  }

  await syncWorkerComplianceTracks(prisma, workerId);

  return NextResponse.json({ received: true });
}
