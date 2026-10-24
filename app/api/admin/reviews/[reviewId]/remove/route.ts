import { NextResponse } from "next/server";
import { z } from "zod";
import { requireRole, AuthError } from "@/lib/auth";
import { moderateReview } from "@/lib/review-moderation";

const schema = z.object({ reason: z.string().min(1, "A moderation reason is required.") });

export async function POST(request: Request, context: { params: Promise<{ reviewId: string }> }) {
  let admin;
  try {
    admin = await requireRole(request, ["ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { reviewId } = await context.params;
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const review = await moderateReview({ reviewId, status: "REMOVED", moderatedBy: admin.userId, reason: parsed.data.reason });
  if (!review) return NextResponse.json({ error: "Review not found." }, { status: 404 });
  return NextResponse.json({ review });
}
