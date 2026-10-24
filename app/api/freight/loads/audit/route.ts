import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";

/**
 * Freight audit-history retrieval (P0-05). Read-only. Returns the append-only
 * FreightAuditEvent trail for a load, newest first. Admin-only.
 */
const ADMIN_ROLES = ["ADMIN", "SUPPORT", "FINANCE_ADMIN", "SUPER_ADMIN"] as const;

export async function GET(request: Request) {
  try {
    await requireRole(request, ADMIN_ROLES as unknown as ("ADMIN")[]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const url = new URL(request.url);
  const loadId = url.searchParams.get("loadId");
  if (!loadId) return NextResponse.json({ error: "loadId is required." }, { status: 400 });

  const events = await prisma.freightAuditEvent.findMany({ where: { loadId }, orderBy: { createdAt: "desc" }, take: 500 });
  return NextResponse.json({ events });
}
