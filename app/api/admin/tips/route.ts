import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";

/**
 * Admin tip reporting — every Tip with its allocations, so an admin can
 * both see the full picture (who tipped, how much, whether it actually
 * succeeded) and act on individual allocations that are ready to pay
 * out (via POST /api/admin/tip-allocations/[id]/pay).
 */
const querySchema = z.object({
  status: z.enum(["PROCESSING", "SUCCEEDED", "FAILED"]).optional(),
  allocationStatus: z.enum(["PENDING", "SCHEDULED", "PROCESSING", "TRANSFERRED", "PAID_OUT", "OFFSET", "FAILED", "HELD", "REVERSED"]).optional(),
});

export async function GET(request: Request) {
  try {
    await requireRole(request, ["ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const { searchParams } = new URL(request.url);
  const parsed = querySchema.safeParse({
    status: searchParams.get("status") ?? undefined,
    allocationStatus: searchParams.get("allocationStatus") ?? undefined,
  });
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const tips = await prisma.tip.findMany({
    where: {
      status: parsed.data.status,
      allocations: parsed.data.allocationStatus ? { some: { status: parsed.data.allocationStatus } } : undefined,
    },
    select: {
      id: true, amountCents: true, status: true, failureReason: true, createdAt: true, succeededAt: true,
      job: { select: { id: true, title: true } },
      load: { select: { id: true, title: true } },
      customer: { select: { user: { select: { firstName: true, lastName: true } } } },
      allocations: {
        select: {
          id: true, amountCents: true, status: true, paidAt: true, paidOutAt: true, failureReason: true,
          worker: { select: { id: true, displayName: true, stripePayoutsEnabled: true } },
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return NextResponse.json({
    tips: tips.map((t) => ({
      id: t.id, amountCents: t.amountCents, status: t.status, failureReason: t.failureReason, createdAt: t.createdAt, succeededAt: t.succeededAt,
      entityTitle: t.job?.title ?? t.load?.title ?? "Untitled",
      entityType: t.job ? "job" as const : "load" as const,
      customerName: `${t.customer.user.firstName} ${t.customer.user.lastName}`,
      allocations: t.allocations,
    })),
  });
}
