import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { csvCell, WAITLIST_INTEREST_LABELS, type WaitlistInterest } from "@/lib/waitlist";

/**
 * Admin waitlist — VASRUE Digital Media, 29 October 2026.
 *
 * GET /api/admin/waitlist (Carl's waitlist work order §3.4). Admin roles only.
 *   ?audience=CUSTOMER|WORKER   filter by list
 *   ?zip=46204                  filter by ZIP (a prefix such as 462 also works)
 *   ?format=csv                 the filtered rows as a CSV download
 * Without format=csv it returns the rows plus top-line counts (total,
 * customers, workers). The counts always cover the whole list; the rows and
 * the CSV follow the filters.
 */
const ADMIN_ROLES = ["ADMIN", "SUPPORT", "FINANCE_ADMIN", "SUPER_ADMIN"] as const;
const MAX_ROWS = 5000;

export async function GET(request: Request) {
  try {
    await requireRole(request, ADMIN_ROLES as unknown as ("ADMIN")[]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const url = new URL(request.url);
  const audienceParam = url.searchParams.get("audience");
  const audience = audienceParam === "CUSTOMER" || audienceParam === "WORKER" ? audienceParam : null;
  const zip = (url.searchParams.get("zip") ?? "").replace(/\D/g, "").slice(0, 5);

  const where: Prisma.WaitlistSignupWhereInput = {
    ...(audience ? { audience } : {}),
    ...(zip ? { zipCode: { startsWith: zip } } : {}),
  };

  const rows = await prisma.waitlistSignup.findMany({ where, orderBy: { createdAt: "desc" }, take: MAX_ROWS });

  if (url.searchParams.get("format") === "csv") {
    const header = ["Email", "Audience", "ZIP", "Interests", "Has truck", "First name", "Source", "Signed up (UTC)"];
    const lines = rows.map((r) =>
      [
        r.email,
        r.audience === "CUSTOMER" ? "Customer" : "Worker",
        r.zipCode,
        r.interests.map((i) => WAITLIST_INTEREST_LABELS[i as WaitlistInterest] ?? i),
        r.hasTruck == null ? "" : r.hasTruck ? "Yes" : "No",
        r.firstName,
        r.source,
        r.createdAt.toISOString(),
      ].map(csvCell).join(","),
    );
    const csv = [header.map(csvCell).join(","), ...lines].join("\r\n") + "\r\n";
    const stamp = new Date().toISOString().slice(0, 10);
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="tempmovers-waitlist-${stamp}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  }

  const grouped = await prisma.waitlistSignup.groupBy({ by: ["audience"], _count: { _all: true } });
  const customers = grouped.find((g) => g.audience === "CUSTOMER")?._count._all ?? 0;
  const workers = grouped.find((g) => g.audience === "WORKER")?._count._all ?? 0;

  return NextResponse.json({
    counts: { total: customers + workers, customers, workers },
    filtered: rows.length,
    truncated: rows.length === MAX_ROWS,
    rows: rows.map((r) => ({
      id: r.id,
      email: r.email,
      audience: r.audience,
      zipCode: r.zipCode,
      interests: r.interests,
      hasTruck: r.hasTruck,
      firstName: r.firstName,
      source: r.source,
      createdAt: r.createdAt.toISOString(),
    })),
  });
}
