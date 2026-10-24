import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";

/**
 * Lookup endpoint for the partner billing/invoice admin UI — same
 * missing-search pattern as the refund console, capture queue, and
 * payout trigger: the billing report and invoice generation routes
 * were already correct, there was just no way to find a partner
 * organization's ID to point them at.
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

  const partners = await prisma.partnerOrganization.findMany({
    where: {
      OR: [
        { id: q },
        { displayName: { contains: q, mode: "insensitive" } },
        { legalName: { contains: q, mode: "insensitive" } },
        { referralCode: { contains: q, mode: "insensitive" } },
      ],
    },
    select: {
      id: true, displayName: true, type: true, monthlyInvoicing: true, active: true,
      _count: { select: { invoices: true } },
    },
    take: 25,
  });

  return NextResponse.json({ results: partners });
}
