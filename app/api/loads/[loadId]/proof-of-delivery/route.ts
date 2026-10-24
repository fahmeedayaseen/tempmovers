import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";

const schema = z.object({ proofOfDeliveryUrl: z.string().url(), signatureUrl: z.string().url().optional() });

export async function POST(request: Request, context: { params: Promise<{ loadId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["MOVER", "DRIVER"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { loadId } = await context.params;
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const load = await prisma.carrierRoute.findUnique({ where: { id: loadId }, include: { assignedWorker: true } });
  if (!load) return NextResponse.json({ error: "Load not found." }, { status: 404 });
  if (!load.assignedWorker || load.assignedWorker.userId !== authed.userId) {
    return NextResponse.json({ error: "This load isn't assigned to you." }, { status: 403 });
  }
  if (load.status !== "IN_TRANSIT" && load.status !== "DELIVERED") {
    return NextResponse.json({ error: `Cannot upload proof of delivery from status ${load.status}.` }, { status: 409 });
  }

  const updated = await prisma.carrierRoute.update({
    where: { id: loadId },
    data: {
      status: "POD_UPLOADED",
      proofOfDeliveryUrl: parsed.data.proofOfDeliveryUrl,
      signatureUrl: parsed.data.signatureUrl,
    },
    select: { id: true, status: true, updatedAt: true },
  });

  await prisma.auditLog.create({
    data: { actorId: authed.userId, action: "POD_UPLOADED", entityType: "CarrierRoute", entityId: loadId },
  });

  return NextResponse.json({ load: updated });
}
