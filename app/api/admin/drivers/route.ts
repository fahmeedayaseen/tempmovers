import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";

/**
 * Lookup endpoint for the settlement generation UI — same missing-search
 * pattern as every other admin panel built this engagement. Generation
 * needs a workerId to act on; nothing let an admin find one.
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

  const drivers = await prisma.workerProfile.findMany({
    where: {
      workerType: { in: ["BOX_TRUCK_DRIVER", "SEMI_DRIVER"] },
      OR: [
        { id: q },
        { displayName: { contains: q, mode: "insensitive" } },
        { user: { email: { contains: q, mode: "insensitive" } } },
      ],
    },
    select: { id: true, displayName: true, workerType: true, operationalStatus: true, stripePayoutsEnabled: true, user: { select: { email: true } } },
    take: 25,
  });

  return NextResponse.json({ drivers });
}
