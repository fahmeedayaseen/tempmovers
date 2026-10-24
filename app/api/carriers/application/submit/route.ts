import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";

/**
 * Carrier application submit (gap contract #4). Validates that the minimum
 * required fields are present, then moves APPLICATION_STARTED -> DOCUMENTS_PENDING.
 * Idempotent: submitting an already-submitted application returns the current
 * status without error. Status is only ever advanced here, never regressed.
 */
const REQUIRED: { field: "legalBusinessName" | "dotNumber" | "mcNumber"; label: string }[] = [
  { field: "legalBusinessName", label: "Legal business name" },
  { field: "dotNumber", label: "DOT number" },
  { field: "mcNumber", label: "MC number" },
];

export async function POST(request: Request) {
  let authed;
  try { authed = await requireRole(request, ["CARRIER", "ADMIN", "SUPER_ADMIN"] as unknown as ("ADMIN")[]); }
  catch (e) { if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; }

  const carrier = await prisma.carrier.findUnique({ where: { ownerUserId: authed.userId } });
  if (!carrier) return NextResponse.json({ error: "No carrier profile." }, { status: 404 });

  // Idempotent: already past APPLICATION_STARTED → return current status.
  if (carrier.status !== "APPLICATION_STARTED") {
    return NextResponse.json({ status: carrier.status, alreadySubmitted: true });
  }

  const missing = REQUIRED.filter((r) => !carrier[r.field]).map((r) => r.label);
  if (missing.length) {
    return NextResponse.json({ error: "Application is incomplete.", missing }, { status: 428 });
  }

  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.carrier.update({ where: { id: carrier.id }, data: { status: "DOCUMENTS_PENDING" } });
    await tx.carrierStatusEvent.create({ data: { carrierId: carrier.id, fromStatus: "APPLICATION_STARTED", toStatus: "DOCUMENTS_PENDING", reason: "Carrier submitted application", changedById: authed.userId } });
    return u;
  });
  return NextResponse.json({ status: updated.status });
}
