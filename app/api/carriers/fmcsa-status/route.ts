import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { isFmcsaCheckStale } from "@/lib/carriers/fmcsa";

/**
 * Carrier-facing FMCSA status read (gap contract #3). Returns a single display
 * state derived from the latest CarrierFmcsaCheck. CRITICAL: a provider outage
 * (lookup error) surfaces as PROVIDER_UNAVAILABLE, NEVER as a rejection — an
 * outage must not read as a carrier failing verification.
 *
 * States: NOT_CHECKED, PENDING, VERIFIED, MISMATCH, STALE, REVIEW_REQUIRED,
 * PROVIDER_UNAVAILABLE.
 */
type FmcsaState = "NOT_CHECKED" | "PENDING" | "VERIFIED" | "MISMATCH" | "STALE" | "REVIEW_REQUIRED" | "PROVIDER_UNAVAILABLE";

export async function GET(request: Request) {
  let authed;
  try { authed = await requireRole(request, ["CARRIER", "ADMIN", "SUPER_ADMIN"] as unknown as ("ADMIN")[]); }
  catch (e) { if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; }

  const carrier = await prisma.carrier.findUnique({
    where: { ownerUserId: authed.userId },
    select: { id: true, dotNumber: true, mcNumber: true },
  });
  if (!carrier) return NextResponse.json({ error: "No carrier profile." }, { status: 404 });

  const latest = await prisma.carrierFmcsaCheck.findFirst({ where: { carrierId: carrier.id }, orderBy: { checkedAt: "desc" } });

  let state: FmcsaState;
  let detail: string | null = null;

  if (!latest) {
    state = "NOT_CHECKED";
  } else if (latest.checkError) {
    // Outage / lookup failure — provider problem, NOT a carrier rejection.
    state = "PROVIDER_UNAVAILABLE";
    detail = "We could not reach the verification provider. This is not a problem with your account; we'll retry automatically.";
  } else if (latest.authorized === null) {
    state = "PENDING";
  } else if (latest.authorized === false) {
    state = "REVIEW_REQUIRED";
    detail = "FMCSA did not confirm active authority. Check your DOT/MC details.";
  } else if (
    (carrier.dotNumber && latest.dotNumber && carrier.dotNumber !== latest.dotNumber) ||
    (carrier.mcNumber && latest.mcNumber && carrier.mcNumber !== latest.mcNumber)
  ) {
    state = "MISMATCH";
    detail = "The DOT/MC on file does not match the last verification. Update your details or re-verify.";
  } else if (isFmcsaCheckStale(latest.checkedAt)) {
    state = "STALE";
    detail = "Your FMCSA verification is out of date and will be refreshed.";
  } else {
    state = "VERIFIED";
  }

  return NextResponse.json({ state, detail, checkedAt: latest?.checkedAt ?? null });
}
