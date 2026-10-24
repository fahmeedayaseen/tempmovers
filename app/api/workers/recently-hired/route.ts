import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { SAFE_WORKER_SELECT } from "@/lib/access/sanitize-worker";

/**
 * Recently hired (Phase 5) — workers the calling customer has actually
 * hired, most recent first. DERIVED entirely from existing Assignment
 * rows (no new model): assignments on the customer's own jobs that
 * reached a genuinely "hired" state, deduplicated to the worker with
 * their latest hire date. Worker data flows through SAFE_WORKER_SELECT.
 *
 * "Hired" = ACCEPTED/CHECKED_IN/CHECKED_OUT/APPROVED — i.e. the worker
 * took the job, not merely INVITED or APPLIED or DECLINED. This mirrors
 * the completion-rate definition's view of what counts as a real
 * engagement.
 */
const HIRED_STATUSES = ["ACCEPTED", "CHECKED_IN", "CHECKED_OUT", "APPROVED"] as const;
const DEFAULT_LIMIT = 20;

export async function GET(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["CUSTOMER", "ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  // The customer profile for this user — assignments are reached via
  // the customer's jobs. An ADMIN with no customer profile simply has
  // no "recently hired" list of their own; that's fine.
  const customer = await prisma.customerProfile.findUnique({ where: { userId: authed.userId }, select: { id: true } });
  if (!customer) return NextResponse.json({ recentlyHired: [] });

  const assignments = await prisma.assignment.findMany({
    where: { status: { in: [...HIRED_STATUSES] }, job: { customerId: customer.id } },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true, worker: { select: SAFE_WORKER_SELECT } },
    take: 200, // bounded scan; dedup below trims to the display limit
  });

  // Deduplicate to each worker's most recent hire (assignments are
  // already newest-first, so the first occurrence wins).
  const seen = new Set<string>();
  const recentlyHired: { hiredAt: Date; worker: (typeof assignments)[number]["worker"] }[] = [];
  for (const a of assignments) {
    if (seen.has(a.worker.id)) continue;
    seen.add(a.worker.id);
    recentlyHired.push({ hiredAt: a.createdAt, worker: a.worker });
    if (recentlyHired.length >= DEFAULT_LIMIT) break;
  }

  return NextResponse.json({ recentlyHired });
}
