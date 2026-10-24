import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { parseSavedSearchParams } from "@/lib/discovery/saved-search";

/**
 * Saved searches (Phase 5) — a named set of directory filter params.
 * Stores CRITERIA, never a cached result set: replay re-runs the params
 * against the live directory. Params are validated on save against the
 * SAME schema the directory uses (via parseSavedSearchParams), so a
 * saved search can never hold filters the directory doesn't support.
 */
const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  params: z.unknown(),
});

export async function GET(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["CUSTOMER", "ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const savedSearches = await prisma.savedSearch.findMany({
    where: { userId: authed.userId },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ savedSearches });
}

export async function POST(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["CUSTOMER", "ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const parsed = createSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  // Validate the filter params against the live directory contract
  // before persisting — junk criteria never get saved.
  const validated = parseSavedSearchParams(parsed.data.params);
  if (!validated.ok) return NextResponse.json({ error: validated.error }, { status: 400 });

  const savedSearch = await prisma.savedSearch.create({
    data: { userId: authed.userId, name: parsed.data.name, params: validated.filter as object },
  });

  return NextResponse.json({ savedSearch }, { status: 201 });
}
