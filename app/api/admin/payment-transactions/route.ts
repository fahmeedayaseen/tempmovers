import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";

/**
 * Lookup endpoint for the admin refund UI — the refund route
 * (POST /api/admin/payment-transactions/[id]/refund) already existed
 * with real logic, but nothing let an admin FIND a transaction ID to
 * refund in the first place. Searches by job/load title, customer
 * name, or a direct transaction/job/load ID.
 */
const schema = z.object({ query: z.string().trim().min(1).max(200) });

export async function GET(request: Request) {
  try {
    await requireRole(request, ["ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const { searchParams } = new URL(request.url);
  const parsed = schema.safeParse({ query: searchParams.get("query") });
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const q = parsed.data.query;

  const transactions = await prisma.paymentTransaction.findMany({
    where: {
      OR: [
        { id: q },
        { jobId: q },
        { loadId: q },
        { job: { title: { contains: q, mode: "insensitive" } } },
        { job: { customer: { user: { OR: [{ firstName: { contains: q, mode: "insensitive" } }, { lastName: { contains: q, mode: "insensitive" } }] } } } },
        { load: { title: { contains: q, mode: "insensitive" } } },
      ],
    },
    include: {
      job: { select: { id: true, title: true, customer: { select: { user: { select: { firstName: true, lastName: true } } } } } },
      load: { select: { id: true, title: true } },
      refunds: { select: { amountCents: true, status: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 25,
  });

  const results = transactions.map((t) => {
    const reservedCents = t.refunds
      .filter((r) => r.status === "SUCCEEDED" || r.status === "PENDING" || r.status === "PROCESSING")
      .reduce((sum, r) => sum + r.amountCents, 0);
    return {
      id: t.id,
      title: t.job?.title ?? t.load?.title ?? "Untitled",
      customerName: t.job?.customer ? `${t.job.customer.user.firstName} ${t.job.customer.user.lastName}` : null,
      type: t.jobId ? "job" as const : "load" as const,
      amountReceivedCents: t.amountReceivedCents,
      refundedAmountCents: t.refundedAmountCents,
      refundableRemainingCents: t.amountReceivedCents - reservedCents,
      currency: t.currency,
      createdAt: t.createdAt,
    };
  });

  return NextResponse.json({ results });
}
