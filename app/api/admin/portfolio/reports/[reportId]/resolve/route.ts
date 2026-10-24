import { runReportResolution } from "@/lib/portfolio/report-resolution";

// Phase 5.5A admin report resolve — thin wrapper over the shared helper.
export async function POST(request: Request, context: { params: Promise<{ reportId: string }> }) {
  const { reportId } = await context.params;
  return runReportResolution(request, reportId, "RESOLVED");
}
