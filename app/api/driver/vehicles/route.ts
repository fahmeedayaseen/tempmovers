import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { markOnboardingStarted, requiresVehicle } from "@/lib/worker-eligibility";

const schema = z.object({
  type: z.enum(["BOX_TRUCK", "SEMI_TRACTOR", "SEMI_TRACTOR_TRAILER", "CARGO_VAN", "OTHER"]),
  year: z.number().int().min(1980).max(new Date().getFullYear() + 1),
  make: z.string().min(1),
  model: z.string().min(1),
  plateNumber: z.string().min(1),
  plateState: z.string().length(2),
  vinLast6: z.string().length(6).optional(),
  capacityDescription: z.string().optional(),
  hasLiftgate: z.boolean().optional(),
  hasPalletJack: z.boolean().optional(),
  registrationExpiresAt: z.string().refine((v) => !Number.isNaN(Date.parse(v)), "Enter a valid date.").optional(),
  // Insurance is captured alongside the vehicle it covers, rather than as a
  // separate model — a commercial policy is inherently tied to one vehicle.
  commercialInsurance: z.boolean().optional(),
  insuranceExpiresAt: z.string().refine((v) => !Number.isNaN(Date.parse(v)), "Enter a valid date.").optional(),
  dotNumber: z.string().optional(),
  mcNumber: z.string().optional(),
});

export async function GET(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["DRIVER"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const worker = await prisma.workerProfile.findUnique({ where: { userId: authed.userId }, include: { vehicles: true } });
  if (!worker) return NextResponse.json({ error: "Worker profile not found." }, { status: 404 });
  if (!requiresVehicle(worker.workerType)) {
    return NextResponse.json({ applicable: false, message: "Vehicle profile does not apply to labor-only movers." });
  }
  const active = worker.vehicles.find((v) => v.active) ?? null;
  return NextResponse.json({ applicable: true, vehicle: active });
}

export async function POST(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["DRIVER"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const worker = await prisma.workerProfile.findUnique({ where: { userId: authed.userId }, include: { vehicles: true } });
  if (!worker) return NextResponse.json({ error: "Worker profile not found." }, { status: 404 });
  if (!requiresVehicle(worker.workerType)) {
    return NextResponse.json({ error: "Vehicle profile does not apply to labor-only movers." }, { status: 400 });
  }

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const input = parsed.data;

  const existing = worker.vehicles.find((v) => v.active);
  const data = {
    type: input.type, year: input.year, make: input.make, model: input.model,
    plateNumber: input.plateNumber, plateState: input.plateState, vinLast6: input.vinLast6,
    capacityDescription: input.capacityDescription, hasLiftgate: input.hasLiftgate ?? false, hasPalletJack: input.hasPalletJack ?? false,
    registrationExpiresAt: input.registrationExpiresAt ? new Date(input.registrationExpiresAt) : undefined,
    commercialInsurance: input.commercialInsurance ?? false,
    insuranceExpiresAt: input.insuranceExpiresAt ? new Date(input.insuranceExpiresAt) : undefined,
    dotNumber: input.dotNumber, mcNumber: input.mcNumber,
    active: true,
  };

  const vehicle = existing
    ? await prisma.vehicle.update({ where: { id: existing.id }, data })
    : await prisma.vehicle.create({ data: { ...data, workerId: worker.id } });

  await markOnboardingStarted(worker.id);
  return NextResponse.json({ vehicle });
}
