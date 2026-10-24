import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { stripe } from "@/lib/stripe";
import { requireRole, AuthError } from "@/lib/auth";

/**
 * The dashboard's "Manage subscription" button previously always started a
 * NEW Checkout session — there was no self-service path for an existing
 * subscriber to update their payment method, view invoices, cancel, or
 * change plans. This is that path: a real Stripe Billing Portal session,
 * resolved server-side from the authenticated worker's own
 * stripeCustomerId, never a client-supplied customer ID.
 *
 * MOVER and DRIVER-family workers (DRIVER_BASIC/OWNER_OPERATOR_PRO/FLEET)
 * share this same endpoint — the portal itself is scoped to whatever
 * subscription(s) exist on that Stripe customer, so there's no need for
 * per-plan branching here.
 */
export async function POST(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["MOVER", "DRIVER"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const worker = await prisma.workerProfile.findUnique({ where: { userId: authed.userId } });
  if (!worker?.stripeCustomerId) {
    return NextResponse.json({ error: "No billing profile found. Start a subscription first." }, { status: 409 });
  }

  const base = process.env.NEXT_PUBLIC_APP_URL;
  if (!base) return NextResponse.json({ error: "NEXT_PUBLIC_APP_URL is not configured." }, { status: 500 });

  const session = await stripe.billingPortal.sessions.create({
    customer: worker.stripeCustomerId,
    return_url: `${base}/dashboard`,
  });

  return NextResponse.json({ url: session.url });
}
