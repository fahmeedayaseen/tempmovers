import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { markOnboardingStarted } from "@/lib/worker-eligibility";

const schema = z.object({
  legalName: z.string().min(1),
  displayName: z.string().min(1).optional(),
  dateOfBirth: z.string().refine((v) => !Number.isNaN(Date.parse(v)), "Enter a valid date."),
  profilePhotoUrl: z.string().url().optional(),
});

export async function GET(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["MOVER", "DRIVER"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const worker = await prisma.workerProfile.findUnique({ where: { userId: authed.userId } });
  if (!worker) return NextResponse.json({ error: "Worker profile not found." }, { status: 404 });
  return NextResponse.json({
    legalName: worker.legalName, displayName: worker.displayName,
    dateOfBirth: worker.dateOfBirth, profilePhotoUrl: worker.profilePhotoUrl,
  });
}

export async function POST(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["MOVER", "DRIVER"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const worker = await prisma.workerProfile.findUnique({ where: { userId: authed.userId } });
  if (!worker) return NextResponse.json({ error: "Worker profile not found." }, { status: 404 });

  const updated = await prisma.workerProfile.update({
    where: { id: worker.id },
    data: {
      legalName: parsed.data.legalName,
      displayName: parsed.data.displayName ?? parsed.data.legalName,
      dateOfBirth: new Date(parsed.data.dateOfBirth),
      profilePhotoUrl: parsed.data.profilePhotoUrl,
    },
  });
  await markOnboardingStarted(worker.id);

  return NextResponse.json({ worker: updated });
}
