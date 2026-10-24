import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { markOnboardingStarted } from "@/lib/worker-eligibility";

const schema = z.object({
  serviceRadiusMiles: z.number().int().min(5).max(500),
});

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
    include: { workerMarkets: { include: { market: true } } },
  });
  if (!worker) return NextResponse.json({ error: "Worker profile not found." }, { status: 404 });
  return NextResponse.json({ homeZip: worker.homeZip, primaryMarketId: worker.primaryMarketId, workerMarkets: worker.workerMarkets });
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
  if (!worker.primaryMarketId) {
    return NextResponse.json({ error: "No primary market on file — this should have been resolved at registration." }, { status: 409 });
  }

  const membership = await prisma.workerMarket.upsert({
    where: { workerId_marketId: { workerId: worker.id, marketId: worker.primaryMarketId } },
    update: { serviceRadiusMiles: parsed.data.serviceRadiusMiles },
    create: { workerId: worker.id, marketId: worker.primaryMarketId, serviceRadiusMiles: parsed.data.serviceRadiusMiles, active: true, acceptingJobs: false },
  });

  await markOnboardingStarted(worker.id);
  return NextResponse.json({ workerMarket: membership });
}
