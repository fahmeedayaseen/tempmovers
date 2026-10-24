import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";

/**
 * Shared implementation for admin report resolution (Phase 5.5A):
 * RESOLVED (report upheld / handled) or DISMISSED (no action). Both
 * require admin/support, both close only an OPEN/REVIEWING report, both
 * record who reviewed it and an optional resolution note, and both write
 * an audit event.
 *
 * Note: resolving a report does NOT itself remove the media — an admin
 * removes media through the separate /remove action, which is audited on
 * its own. This keeps "the report is handled" distinct from "the media
 * was taken down," so the two decisions are independently traceable.
 */
export async function runReportResolution(request: Request, reportId: string, outcome: "RESOLVED" | "DISMISSED") {
  let authed;
  try {
    authed = await requireRole(request, ["ADMIN", "SUPPORT"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const body = await request.json().catch(() => ({}));
  const resolutionNote = typeof body?.resolutionNote === "string" ? body.resolutionNote : null;

  const report = await prisma.portfolioReport.findUnique({ where: { id: reportId }, select: { id: true, status: true, mediaId: true } });
  if (!report) return NextResponse.json({ error: "Report not found." }, { status: 404 });
  if (report.status === "RESOLVED" || report.status === "DISMISSED") {
    return NextResponse.json({ error: "This report is already closed." }, { status: 409 });
  }

  const updated = await prisma.portfolioReport.update({
    where: { id: report.id },
    data: { status: outcome, reviewedById: authed.userId, reviewedAt: new Date(), resolutionNote },
    select: { id: true, status: true, reviewedAt: true },
  });

  await prisma.auditLog.create({
    data: { actorId: authed.userId, action: outcome === "RESOLVED" ? "PORTFOLIO_REPORT_RESOLVED" : "PORTFOLIO_REPORT_DISMISSED", entityType: "PortfolioReport", entityId: report.id, details: { mediaId: report.mediaId } },
  });

  return NextResponse.json({ report: updated });
}
