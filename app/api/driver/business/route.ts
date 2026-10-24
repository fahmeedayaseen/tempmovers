import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { markOnboardingStarted } from "@/lib/worker-eligibility";
import { verifyCarrierByUsdot } from "@/lib/fmcsa";

const schema = z.object({
  businessName: z.string().min(1),
  dba: z.string().optional(),
  usdotNumber: z.string().regex(/^\d{6,8}$/, "Enter a valid USDOT number."),
  mcNumber: z.string().optional(),
  einLast4: z.string().length(4).optional(),
});

export async function GET(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["DRIVER"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const worker = await prisma.workerProfile.findUnique({ where: { userId: authed.userId }, include: { carrierVerification: true } });
  if (!worker) return NextResponse.json({ error: "Worker profile not found." }, { status: 404 });
  if (worker.workerType !== "SEMI_DRIVER") {
    return NextResponse.json({ applicable: false, message: "Business profile only applies to semi-truck carrier accounts." });
  }
  return NextResponse.json({
    applicable: true,
    businessName: worker.businessName, dba: worker.dba, mcNumber: worker.mcNumber, einLast4: worker.einLast4,
    carrierVerification: worker.carrierVerification,
  });
}

export async function POST(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["DRIVER"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const worker = await prisma.workerProfile.findUnique({ where: { userId: authed.userId } });
  if (!worker) return NextResponse.json({ error: "Worker profile not found." }, { status: 404 });
  if (worker.workerType !== "SEMI_DRIVER") {
    return NextResponse.json({ error: "Business profile only applies to semi-truck carrier accounts." }, { status: 400 });
  }

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const updated = await prisma.workerProfile.update({
    where: { id: worker.id },
    data: { businessName: parsed.data.businessName, dba: parsed.data.dba, mcNumber: parsed.data.mcNumber, einLast4: parsed.data.einLast4 },
  });

  // Run the real FMCSA baseline check now that we have a USDOT number.
  // Doesn't block saving the rest of the business profile if FMCSA isn't
  // configured or the lookup fails — the onboarding evaluator will simply
  // keep the DOT/MC step incomplete until a verification record exists.
  try {
    await verifyCarrierByUsdot(worker.id, parsed.data.usdotNumber);
  } catch {
    // FmcsaNotConfiguredError or a lookup failure — not fatal to this save.
  }

  await markOnboardingStarted(worker.id);
  return NextResponse.json({ worker: updated });
}
