import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";

export async function GET(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["CUSTOMER", "MOVER", "DRIVER", "ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const [customerProfile, workerProfile] = await Promise.all([
    prisma.customerProfile.findUnique({ where: { userId: authed.userId }, select: { id: true } }),
    prisma.workerProfile.findUnique({ where: { userId: authed.userId }, select: { id: true } }),
  ]);

  return NextResponse.json({
    userId: authed.userId,
    role: authed.role,
    workerId: workerProfile?.id ?? null,
    customerId: customerProfile?.id ?? null,
  });
}
