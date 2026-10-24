import { runModerationAction } from "@/lib/portfolio/moderation-action";

// Phase 5.5A admin moderation: restore. Thin wrapper — all auth,
// transition-legality, status write, and audit logic lives in the shared
// runModerationAction helper so the four actions can't drift apart.
export async function POST(request: Request, context: { params: Promise<{ mediaId: string }> }) {
  const { mediaId } = await context.params;
  return runModerationAction(request, mediaId, "restore");
}
