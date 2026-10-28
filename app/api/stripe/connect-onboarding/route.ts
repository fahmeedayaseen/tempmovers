import { NextResponse } from "next/server";
import { z } from "zod";
import { stripe } from "@/lib/stripe";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { captureIntegrationAlert } from "@/lib/monitoring";

const schema = z.object({ workerId: z.string() });

export async function POST(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["MOVER", "DRIVER", "ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const refreshUrl = process.env.STRIPE_CONNECT_REFRESH_URL;
  const returnUrl = process.env.STRIPE_CONNECT_RETURN_URL;
  if (!refreshUrl || !returnUrl) {
    return NextResponse.json({ error: "Stripe Connect callback URLs are not configured." }, { status: 500 });
  }

  const worker = await prisma.workerProfile.findUnique({ where: { id: parsed.data.workerId }, include: { user: true } });
  if (!worker) return NextResponse.json({ error: "Worker not found." }, { status: 404 });
  if (authed.role !== "ADMIN" && worker.user.id !== authed.userId) {
    return NextResponse.json({ error: "Not your worker profile." }, { status: 403 });
  }

  // BLOCK-18 — VASRUE Digital Media, 27 October 2026.
  //
  // Both Stripe calls below were unguarded. Any Stripe-side refusal escaped
  // as an unhandled exception: the worker got an empty 500 and nobody was
  // told. Confirmed on staging, where the platform account has not enabled
  // Connect yet and Stripe answers "You can only create new accounts if
  // you've signed up for Connect". Now the failure is alerted with Stripe's
  // own message and the worker gets a clear 502 — the same pattern
  // job-payment-intent already uses for a failed Stripe call.
  const connectUnavailable = (step: string, error: unknown) => {
    captureIntegrationAlert(`Stripe Connect onboarding failed at ${step}.`, {
      area: "stripe", workerId: worker.id, error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: "Payout setup is unavailable right now. The TempMovers team has been notified." }, { status: 502 });
  };

  let accountId: string;
  try {
    accountId =
      worker.stripeAccountId ??
      (
        await stripe.accounts.create(
          {
            type: "express",
            // Resolved from the worker's own verified account record, never
            // from client input — a client-supplied email here would let
            // someone register a Connect payout account under an address
            // they don't control (or worse, someone else's).
            email: worker.user.email,
            capabilities: { transfers: { requested: true } },
            metadata: { workerId: worker.id },
          },
          { idempotencyKey: `connect-account:${worker.id}` },
        )
      ).id;
  } catch (error) {
    return connectUnavailable("account creation", error);
  }

  // Persist immediately — an account created on Stripe's side but never saved
  // here would silently orphan itself and get recreated (with a wasted idempotency
  // key collision) on the next onboarding attempt.
  if (!worker.stripeAccountId) {
    await prisma.workerProfile.update({ where: { id: worker.id }, data: { stripeAccountId: accountId } });
  }

  let link;
  try {
    link = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: refreshUrl,
      return_url: returnUrl,
      type: "account_onboarding",
    });
  } catch (error) {
    return connectUnavailable("onboarding link", error);
  }

  return NextResponse.json({ accountId, url: link.url });
}

