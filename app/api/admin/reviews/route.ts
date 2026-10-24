import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";

export async function GET(request: Request) {
  try {
    await requireRole(request, ["ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");
  const reportedOnly = searchParams.get("reported") === "true";

  const reviews = await prisma.review.findMany({
    where: {
      ...(status ? { status: status as "PENDING" | "PUBLISHED" | "HIDDEN" | "REMOVED" } : {}),
      ...(reportedOnly ? { reportedAt: { not: null } } : {}),
    },
    include: {
      worker: { select: { id: true, displayName: true } },
      customer: { select: { id: true, user: { select: { firstName: true, lastName: true } } } },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return NextResponse.json({ reviews });
}
