import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";

/**
 * A customer's own posted freight loads, full detail — the load
 * equivalent of GET /api/jobs's CUSTOMER branch, which already existed.
 * No equivalent existed for loads; needed here specifically so a
 * customer can see their own completed loads to tip on, but genuinely
 * useful beyond that too (a customer previously had no way to see their
 * own posted loads at all after posting them).
 */
export async function GET(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["CUSTOMER", "ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const loads = await prisma.carrierRoute.findMany({
    where: { postedByUserId: authed.userId },
    orderBy: { pickupDate: "desc" },
    take: 50,
  });

  return NextResponse.json({ loads });
}
