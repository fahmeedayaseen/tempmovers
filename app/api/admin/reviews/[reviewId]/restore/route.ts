import { NextResponse } from "next/server";
import { requireRole, AuthError } from "@/lib/auth";
import { moderateReview } from "@/lib/review-moderation";

export async function POST(request: Request, context: { params: Promise<{ reviewId: string }> }) {
  let admin;
  try {
    admin = await requireRole(request, ["ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { reviewId } = await context.params;

  const review = await moderateReview({ reviewId, status: "PUBLISHED", moderatedBy: admin.userId });
  if (!review) return NextResponse.json({ error: "Review not found." }, { status: 404 });
  return NextResponse.json({ review });
}
