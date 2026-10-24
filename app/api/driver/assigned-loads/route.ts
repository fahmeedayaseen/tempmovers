import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { FULL_ASSIGNED_LOAD_SELECT } from "@/lib/access/sanitize-load";

/**
 * Durable "view my assigned loads again" endpoint — the gap found while
 * verifying the full freight path. POST /api/loads/[loadId]/request
 * already correctly returns full details (exact addresses, shipper
 * contact, access code) the MOMENT a driver is assigned, but that was
 * the only time it was ever returned: GET /api/driver/loads always
 * applies the sanitized selector regardless of assignment, and it only
 * lists OPEN/OFFER_RECEIVED loads anyway — a load moves to ASSIGNED
 * status and drops off that board entirely once claimed. A driver who
 * navigated away and came back had no route in this codebase that
 * would show them the address they need to actually complete the
 * delivery.
 *
 * Deliberately a separate endpoint rather than a branch inside
 * GET /api/driver/loads — that route's whole shape (visibility rules,
 * market filtering, OPEN/OFFER_RECEIVED status filter) is about
 * browsing opportunities, not tracking a driver's own committed work;
 * folding "and also show my assigned loads" into it would have meant
 * either weakening its filters or adding a parallel code path inside
 * the same function, either of which risks accidentally affecting the
 * board's own sanitization guarantees. A dedicated route with its own
 * simple assignedWorkerId filter is safer to reason about and verify.
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

  const loads = await prisma.carrierRoute.findMany({
    // Deliberate choice, not an oversight: excludes CANCELED specifically.
    // This schema's LoadStatus enum has no ARCHIVED status at all — checked
    // directly rather than assumed. CANCELED means the assignment is void
    // and the driver has no further obligation on it; there's no ongoing
    // legitimate need for them to keep seeing a shipper's exact address and
    // contact info for a load that never happened, so this narrows
    // visibility rather than retaining it by default. DELIVERED,
    // POD_UPLOADED, and SETTLED are intentionally KEPT — those represent
    // actual completed work a driver may need to reference later (proof-of-
    // delivery disputes, earnings reconciliation, a commodity-related
    // claim), so this endpoint is "my active and completed assignments,"
    // not "my currently active assignments only."
    where: { assignedWorkerId: worker.id, status: { not: "CANCELED" } },
    select: FULL_ASSIGNED_LOAD_SELECT,
    orderBy: { pickupDate: "asc" },
    take: 50,
  });

  return NextResponse.json({ loads });
}
