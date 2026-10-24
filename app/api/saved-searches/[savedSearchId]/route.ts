import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { parseSavedSearchParams } from "@/lib/discovery/saved-search";

/**
 * A single saved search (Phase 5): delete it, or REPLAY it. Replay
 * re-validates the stored params against the current directory schema
 * (a search saved before a schema change can't replay stale params)
 * and hands back the validated filter as a query string the client
 * applies to the directory route — the saved row never holds results,
 * only criteria, so replayed results are always current.
 *
 * Replay intentionally returns the filter/querystring rather than
 * proxying the directory search itself: the directory is partner-scoped
 * (needs a partnerId + partner read access), while a saved search is
 * user-scoped. Making replay return the criteria keeps the partner
 * authorization check where it belongs — on the directory route — instead
 * of duplicating it here.
 */
export async function GET(request: Request, context: { params: Promise<{ savedSearchId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["CUSTOMER", "ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { savedSearchId } = await context.params;

  const search = await prisma.savedSearch.findUnique({ where: { id: savedSearchId } });
  if (!search || search.userId !== authed.userId) {
    return NextResponse.json({ error: "Saved search not found." }, { status: 404 });
  }

  const validated = parseSavedSearchParams(search.params);
  if (!validated.ok) {
    // Stored params no longer valid for the current directory contract.
    return NextResponse.json({ error: validated.error, stale: true }, { status: 409 });
  }

  // Build a query string the client applies to the directory route.
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(validated.filter)) {
    if (v != null) qs.set(k, String(v));
  }

  return NextResponse.json({ filter: validated.filter, queryString: qs.toString() });
}

export async function DELETE(request: Request, context: { params: Promise<{ savedSearchId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["CUSTOMER", "ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { savedSearchId } = await context.params;

  const search = await prisma.savedSearch.findUnique({ where: { id: savedSearchId }, select: { id: true, userId: true } });
  if (!search || search.userId !== authed.userId) {
    return NextResponse.json({ error: "Saved search not found." }, { status: 404 });
  }

  await prisma.savedSearch.delete({ where: { id: savedSearchId } });
  return NextResponse.json({ deleted: true });
}
