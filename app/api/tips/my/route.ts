import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";

/**
 * A worker's own tip history — their TipAllocation rows, joined with
 * enough of the parent Tip and the underlying job/load to show what
 * each tip was actually for.
 */
export async function GET(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["MOVER", "DRIVER"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const worker = await prisma.workerProfile.findUnique({ where: { userId: authed.userId } });
  if (!worker) return NextResponse.json({ error: "No worker profile found for this account." }, { status: 404 });

  const allocations = await prisma.tipAllocation.findMany({
    where: { workerId: worker.id },
    select: {
      id: true, amountCents: true, status: true, paidAt: true, paidOutAt: true, failureReason: true, createdAt: true,
      tip: { select: { id: true, amountCents: true, createdAt: true, job: { select: { title: true } }, load: { select: { title: true } } } },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return NextResponse.json({
    allocations: allocations.map((a) => ({
      id: a.id, amountCents: a.amountCents, status: a.status, paidAt: a.paidAt, paidOutAt: a.paidOutAt, failureReason: a.failureReason, createdAt: a.createdAt,
      entityTitle: a.tip.job?.title ?? a.tip.load?.title ?? "Untitled",
      tipTotalCents: a.tip.amountCents,
    })),
  });
}
