import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { verifyCarrierByUsdot, FmcsaNotConfiguredError } from "@/lib/fmcsa";

export async function POST(request: Request, context: { params: Promise<{ workerId: string }> }) {
  let admin;
  try {
    admin = await requireRole(request, ["ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { workerId } = await context.params;

  const worker = await prisma.workerProfile.findUnique({ where: { id: workerId }, include: { carrierVerification: true } });
  if (!worker) return NextResponse.json({ error: "Worker not found." }, { status: 404 });
  if (!worker.carrierVerification?.usdotNumber) {
    return NextResponse.json({ error: "No USDOT number on file for this worker." }, { status: 409 });
  }

  let result;
  try {
    result = await verifyCarrierByUsdot(worker.id, worker.carrierVerification.usdotNumber);
  } catch (e) {
    if (e instanceof FmcsaNotConfiguredError) return NextResponse.json({ error: e.message }, { status: 500 });
    throw e;
  }

  await prisma.auditLog.create({
    data: { actorId: admin.userId, action: "FMCSA_MANUAL_REFRESH", entityType: "WorkerProfile", entityId: workerId, details: { decision: result.decision } },
  });

  return NextResponse.json({ carrierVerification: result });
}
