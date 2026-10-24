import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { stripe } from "@/lib/stripe";
import { requireRole, AuthError } from "@/lib/auth";
import { getScreeningQuote, ScreeningPackageNotConfiguredError } from "@/lib/screening/packages";

const schema = z.object({
  feeDisclosureAccepted: z.literal(true, { errorMap: () => ({ message: "You must accept the screening fee disclosure." }) }),
  fcraAuthorizationAccepted: z.literal(true, { errorMap: () => ({ message: "You must accept the FCRA background-check authorization." }) }),
});

const ACTIVE_CHARGE_STATUSES = ["PAID", "SCREENING_ORDERED", "SCREENING_PENDING", "APPROVED"] as const;

/**
 * Creates a one-time Stripe Checkout session for the applicant's screening
 * fee. Deliberately NOT the recurring subscription checkout
 * (app/api/stripe/worker-subscription/route.ts) — Afterpay/Clearpay only
 * works in Checkout payment mode, never subscription mode, so these stay
 * two separate flows with two separate metadata namespaces
 * (type: "SCREENING_CHARGE" here vs. the subscription's own metadata) so
 * the webhook can never confuse one for the other.
 */
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

  const worker = await prisma.workerProfile.findUnique({
    where: { userId: authed.userId },
    include: { user: true, screeningCharges: true },
  });
  if (!worker) return NextResponse.json({ error: "Worker profile not found." }, { status: 404 });

  const existingActive = worker.screeningCharges.find((charge) => ACTIVE_CHARGE_STATUSES.includes(charge.status as typeof ACTIVE_CHARGE_STATUSES[number]));
  if (existingActive) {
    return NextResponse.json({ error: "A screening payment or order already exists." }, { status: 409 });
  }

  let quote;
  try {
    quote = getScreeningQuote(worker.workerType);
  } catch (e) {
    if (e instanceof ScreeningPackageNotConfiguredError) return NextResponse.json({ error: e.message }, { status: 500 });
    throw e;
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) return NextResponse.json({ error: "Application URL is not configured." }, { status: 500 });

  const screeningCharge = await prisma.screeningCharge.create({
    data: {
      workerId: worker.id,
      packageSlug: quote.packageSlug,
      baseAmountCents: quote.baseAmountCents,
      passThroughAmountCents: quote.estimatedPassThroughCents,
      totalAmountCents: quote.totalAmountCents,
      status: "CHECKOUT_PENDING",
      feeDisclosureVersion: "screening-fee-v2",
      feeDisclosureAcceptedAt: new Date(),
      fcraAuthorizationAt: new Date(),
    },
  });

  const session = await stripe.checkout.sessions.create(
    {
      mode: "payment",
      // Dynamic payment methods so Stripe only offers Afterpay/Clearpay
      // when it determines the account, currency, amount, and customer
      // are actually eligible — never force it into payment_method_types.
      automatic_payment_methods: { enabled: true },
      customer_email: worker.user.email,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: quote.totalAmountCents,
          product_data: {
            name: quote.displayName,
            description: "One-time screening fee. Payment does not guarantee platform approval.",
          },
        },
      }],
      metadata: {
        type: "SCREENING_CHARGE",
        screeningChargeId: screeningCharge.id,
        workerId: worker.id,
        role: worker.workerType,
      },
      payment_intent_data: {
        metadata: {
          type: "SCREENING_CHARGE",
          screeningChargeId: screeningCharge.id,
          workerId: worker.id,
        },
      },
      success_url: `${appUrl}/onboarding/screening?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl}/onboarding/screening?checkout=canceled`,
    },
    { idempotencyKey: `screening-checkout:${screeningCharge.id}` },
  );

  await prisma.screeningCharge.update({
    where: { id: screeningCharge.id },
    data: { stripeCheckoutSessionId: session.id },
  });

  return NextResponse.json({ checkoutUrl: session.url });
}
