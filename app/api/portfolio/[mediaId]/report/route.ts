import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";

/**
 * Customer reports a piece of approved public portfolio media (Phase
 * 5.5A). Reports are only accepted from authenticated users and only
 * against CURRENTLY APPROVED, visible media — you can't report something
 * that isn't public. Duplicate OPEN reports by the same reporter for the
 * same media are collapsed (idempotent) rather than piling up.
 */
const schema = z.object({
  reason: z.enum(["INAPPROPRIATE", "SPAM", "COPYRIGHT", "PRIVACY", "MISLEADING", "OTHER"]),
  details: z.string().max(2000).optional(),
});

export async function POST(request: Request, context: { params: Promise<{ mediaId: string }> }) {
  let authed;
  try {
    // Any authenticated account may report; customers are the primary
    // reporters but a signed-in worker/admin can flag too.
    authed = await requireRole(request, ["CUSTOMER", "MOVER", "DRIVER", "ADMIN", "SUPPORT"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { mediaId } = await context.params;

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  // Only currently-approved, visible media can be reported.
  const media = await prisma.portfolioMedia.findUnique({ where: { id: mediaId }, select: { id: true, status: true, deletedAt: true, removedAt: true } });
  if (!media || media.status !== "APPROVED" || media.deletedAt || media.removedAt) {
    return NextResponse.json({ error: "This media is not available to report." }, { status: 404 });
  }

  // Prevent duplicate OPEN/REVIEWING reports from the same reporter.
  const existing = await prisma.portfolioReport.findFirst({
    where: { mediaId, reporterUserId: authed.userId, status: { in: ["OPEN", "REVIEWING"] } },
    select: { id: true },
  });
  if (existing) {
    return NextResponse.json({ report: { id: existing.id }, alreadyReported: true }, { status: 200 });
  }

  const report = await prisma.portfolioReport.create({
    data: { mediaId, reporterUserId: authed.userId, reason: parsed.data.reason, details: parsed.data.details ?? null },
    select: { id: true, status: true, createdAt: true },
  });

  await prisma.auditLog.create({
    data: { actorId: authed.userId, action: "PORTFOLIO_REPORT_CREATED", entityType: "PortfolioReport", entityId: report.id, details: { mediaId, reason: parsed.data.reason } },
  });

  return NextResponse.json({ report }, { status: 201 });
}
