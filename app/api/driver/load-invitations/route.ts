import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";

/**
 * A driver's inbox of pending freight load invitations — mirrors
 * GET /api/worker/invitations for moving jobs. Only shows non-expired,
 * still-PENDING invitations; expiration is enforced authoritatively at
 * accept/decline time, same lazy-expiration reasoning as the job
 * invitation inbox.
 */
export async function GET(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["DRIVER"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const worker = await prisma.workerProfile.findUnique({ where: { userId: authed.userId } });
  if (!worker) return NextResponse.json({ error: "Worker profile not found." }, { status: 404 });

  const invitations = await prisma.carrierRouteInvitation.findMany({
    where: { workerId: worker.id, status: "PENDING", expiresAt: { gt: new Date() } },
    select: {
      id: true, expiresAt: true, createdAt: true,
      carrierRoute: { select: { id: true, title: true, originCity: true, originState: true, destinationCity: true, destinationState: true, pickupDate: true, equipmentType: true, grossCarrierCents: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ invitations });
}
