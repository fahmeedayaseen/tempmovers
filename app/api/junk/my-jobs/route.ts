import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { createDownloadUrl, StorageNotConfiguredError } from "@/lib/storage";
import { canTakeJunkJobs, isJunkOnlyWorkerType, junkCrewRoleFor } from "@/lib/junk/crew";

/**
 * Junk removal — VASRUE Digital Media, 28 October 2026.
 *
 * A worker's junk removal seats, for the junk board in the worker portal
 * (Carl's junk spec §7–§8). Once a worker holds a seat they need what the
 * public feed withholds: the pickup address, the customer's access notes and
 * photos, and what they will be paid. Seats that were declined or canceled
 * are left out. Also reports whether this worker can take junk jobs at all,
 * so the portal can offer the opt-in switch.
 */
export async function GET(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["MOVER", "DRIVER"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const worker = await prisma.workerProfile.findUnique({ where: { userId: authed.userId }, select: { id: true, workerType: true, junkRemovalEnabled: true } });
  if (!worker) return NextResponse.json({ error: "Worker profile not found." }, { status: 404 });

  const assignments = await prisma.assignment.findMany({
    where: { workerId: worker.id, junkCrewRole: { not: null }, status: { notIn: ["DECLINED", "CANCELED"] } },
    orderBy: { job: { startsAt: "asc" } },
    take: 50,
    select: {
      id: true, status: true, junkCrewRole: true, agreedEarningsCents: true, checkInAt: true, checkOutAt: true, actualHours: true,
      payout: { select: { status: true, netPayoutCents: true } },
      job: {
        select: {
          id: true, title: true, status: true, startsAt: true, description: true, estimatedHours: true,
          address: { select: { line1: true, line2: true, city: true, state: true, postalCode: true } },
          junkRemovalDetail: {
            select: {
              pricingMode: true, volumeTier: true, items: true, itemCategories: true, itemNotes: true, itemLocation: true,
              hasHeavyItems: true, specialItems: true, helpersRequired: true, photoKeys: true,
              beforePhotoKeys: true, afterPhotoKeys: true, dumpReceiptKey: true,
            },
          },
        },
      },
    },
  });

  // Signed, five-minute links to the customer's photos. Without storage
  // configured there are simply no links; the job itself still works.
  let storageConfigured = true;
  const sign = async (keys: string[]) => {
    if (!storageConfigured) return [];
    try {
      return await Promise.all(keys.map((k) => createDownloadUrl(k)));
    } catch (e) {
      if (e instanceof StorageNotConfiguredError) { storageConfigured = false; return []; }
      throw e;
    }
  };

  const jobs = await Promise.all(assignments.map(async (a) => {
    const d = a.job.junkRemovalDetail;
    return {
      assignmentId: a.id,
      seat: a.junkCrewRole,
      status: a.status,
      shareCents: a.agreedEarningsCents,
      checkInAt: a.checkInAt,
      checkOutAt: a.checkOutAt,
      payout: a.payout,
      job: {
        id: a.job.id, title: a.job.title, status: a.job.status, startsAt: a.job.startsAt, estimatedHours: a.job.estimatedHours,
        accessNotes: a.job.description, address: a.job.address,
      },
      detail: d && {
        pricingMode: d.pricingMode, volumeTier: d.volumeTier, items: d.items, itemCategories: d.itemCategories, itemNotes: d.itemNotes,
        itemLocation: d.itemLocation, hasHeavyItems: d.hasHeavyItems, specialItems: d.specialItems, helpersRequired: d.helpersRequired,
        customerPhotoUrls: await sign(d.photoKeys),
        proof: { before: d.beforePhotoKeys.length, after: d.afterPhotoKeys.length, dumpReceipt: Boolean(d.dumpReceiptKey) },
      },
    };
  }));

  return NextResponse.json({
    capability: {
      workerType: worker.workerType,
      seat: junkCrewRoleFor(worker.workerType),
      junkOnly: isJunkOnlyWorkerType(worker.workerType),
      junkRemovalEnabled: worker.junkRemovalEnabled,
      canTakeJunkJobs: canTakeJunkJobs(worker),
    },
    storageConfigured,
    jobs,
  });
}
