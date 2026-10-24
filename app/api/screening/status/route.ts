import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { getScreeningQuote, ScreeningPackageNotConfiguredError } from "@/lib/screening/packages";

export async function GET(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["MOVER", "DRIVER"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const worker = await prisma.workerProfile.findUnique({
    where: { userId: authed.userId },
    include: { screeningCharges: { orderBy: { createdAt: "desc" }, take: 1 }, compliance: true },
  });
  if (!worker) return NextResponse.json({ error: "Worker profile not found." }, { status: 404 });

  let quote = null;
  try {
    quote = getScreeningQuote(worker.workerType);
  } catch (e) {
    if (!(e instanceof ScreeningPackageNotConfiguredError)) throw e;
  }

  return NextResponse.json({
    quote,
    latestCharge: worker.screeningCharges[0] ?? null,
    complianceApproved: worker.compliance?.adminApprovalStatus === "APPROVED",
  });
}
