import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { canBePrimary, workerCanDelete } from "@/lib/portfolio/state";

/**
 * Edit (PATCH) or soft-delete (DELETE) one of the owner's own portfolio
 * items (Phase 5.5). Editing title/description/category/order/primary is
 * allowed; REPLACING the image is not done here (that's a new presign →
 * new PENDING record, so approval is never silently preserved). Setting
 * a new primary clears the previous primary atomically in a transaction.
 */
const patchSchema = z.object({
  title: z.string().max(120).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  categoryId: z.string().cuid().nullable().optional(),
  displayOrder: z.number().int().min(0).optional(),
  isPrimary: z.boolean().optional(),
});

async function ownedMedia(userId: string, mediaId: string) {
  const worker = await prisma.workerProfile.findUnique({ where: { userId }, select: { id: true } });
  if (!worker) return { worker: null, media: null };
  const media = await prisma.portfolioMedia.findUnique({ where: { id: mediaId } });
  if (!media || media.deletedAt || media.workerId !== worker.id) return { worker, media: null };
  return { worker, media };
}

export async function PATCH(request: Request, context: { params: Promise<{ mediaId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["MOVER", "DRIVER"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { mediaId } = await context.params;
  const parsed = patchSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { worker, media } = await ownedMedia(authed.userId, mediaId);
  if (!worker) return NextResponse.json({ error: "Worker profile not found." }, { status: 404 });
  if (!media) return NextResponse.json({ error: "Media not found." }, { status: 404 });

  if (parsed.data.isPrimary === true && !canBePrimary(media.status)) {
    return NextResponse.json({ error: "Only an approved image can be set as primary." }, { status: 409 });
  }

  const data: Record<string, unknown> = {};
  if (parsed.data.title !== undefined) data.title = parsed.data.title;
  if (parsed.data.description !== undefined) data.description = parsed.data.description;
  if (parsed.data.categoryId !== undefined) data.categoryId = parsed.data.categoryId;
  if (parsed.data.displayOrder !== undefined) data.displayOrder = parsed.data.displayOrder;

  // Primary change is atomic: clear the worker's existing primary, then
  // set this one — in a transaction so there's never two primaries.
  const result = await prisma.$transaction(async (tx) => {
    if (parsed.data.isPrimary === true) {
      await tx.portfolioMedia.updateMany({ where: { workerId: worker.id, isPrimary: true }, data: { isPrimary: false } });
      data.isPrimary = true;
    } else if (parsed.data.isPrimary === false) {
      data.isPrimary = false;
    }
    return tx.portfolioMedia.update({ where: { id: media.id }, data, select: { id: true, title: true, description: true, categoryId: true, displayOrder: true, isPrimary: true, status: true } });
  });

  await prisma.auditLog.create({
    data: { actorId: authed.userId, action: "PORTFOLIO_EDIT", entityType: "PortfolioMedia", entityId: media.id, details: { fields: Object.keys(data) } },
  });

  return NextResponse.json({ media: result });
}

export async function DELETE(request: Request, context: { params: Promise<{ mediaId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["MOVER", "DRIVER"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { mediaId } = await context.params;
  const { worker, media } = await ownedMedia(authed.userId, mediaId);
  if (!worker) return NextResponse.json({ error: "Worker profile not found." }, { status: 404 });
  if (!media) return NextResponse.json({ error: "Media not found." }, { status: 404 });

  // Worker may freely delete non-approved items. Deleting an APPROVED
  // item follows audit policy: allowed, but recorded distinctly. Either
  // way it's a soft-delete (deletedAt) that immediately removes it from
  // public visibility and queues the storage object for cleanup.
  const wasApproved = media.status === "APPROVED";
  if (!workerCanDelete(media.status) && !wasApproved) {
    return NextResponse.json({ error: "This item can't be deleted in its current state." }, { status: 409 });
  }

  await prisma.portfolioMedia.update({ where: { id: media.id }, data: { deletedAt: new Date(), isPrimary: false } });
  await prisma.auditLog.create({
    data: { actorId: authed.userId, action: wasApproved ? "PORTFOLIO_DELETE_APPROVED" : "PORTFOLIO_DELETE", entityType: "PortfolioMedia", entityId: media.id, details: { previousState: media.status } },
  });

  return NextResponse.json({ deleted: true });
}
