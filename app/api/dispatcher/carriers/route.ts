import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireDispatcher, listAccessibleCarrierIds, AuthError } from "@/lib/dispatcher/access";

/**
 * Assigned carriers — the carrier switcher source. Returns ONLY carriers that
 * have granted this dispatcher ACTIVE access, with the granted permission set.
 * Carrier-profile fields only; no factoring/compliance/finance data.
 */
export async function GET(request: Request) {
  let authed;
  try { authed = await requireDispatcher(request); }
  catch (e) { if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; }

  const now = new Date();
  const access = await prisma.dispatcherCarrierAccess.findMany({
    where: { dispatcherId: authed.userId, status: "ACTIVE", OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    select: {
      permissions: true, expiresAt: true,
      carrier: { select: { id: true, legalBusinessName: true, dotNumber: true, mcNumber: true, status: true, homeTerminal: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  const carriers = access.map((a) => ({ ...a.carrier, permissions: a.permissions, accessExpiresAt: a.expiresAt }));
  return NextResponse.json({ carriers });
}
