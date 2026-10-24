import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { createDownloadUrl, StorageNotConfiguredError } from "@/lib/storage";

export async function GET(request: Request, context: { params: Promise<{ documentId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["MOVER", "DRIVER", "ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { documentId } = await context.params;

  const document = await prisma.workerDocument.findUnique({ where: { id: documentId }, include: { worker: true } });
  if (!document) return NextResponse.json({ error: "Document not found." }, { status: 404 });
  if (authed.role !== "ADMIN" && document.worker.userId !== authed.userId) {
    return NextResponse.json({ error: "Not your document." }, { status: 403 });
  }

  let url: string;
  try {
    url = await createDownloadUrl(document.fileUrl);
  } catch (e) {
    if (e instanceof StorageNotConfiguredError) return NextResponse.json({ error: e.message }, { status: 500 });
    throw e;
  }

  await prisma.auditLog.create({
    data: { actorId: authed.userId, action: "DOCUMENT_DOWNLOAD_ACCESSED", entityType: "WorkerDocument", entityId: document.id },
  });

  return NextResponse.json({ url, expiresInSeconds: 300 });
}
