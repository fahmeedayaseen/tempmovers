import type Stripe from "stripe";
import { stripe } from "@/lib/stripe";

// ---------------------------------------------------------------------------
// BLOCK-19 — VASRUE Digital Media, 28 October 2026.
//
// Both payment-intent routes refused a second request for a booking that
// already had a PaymentIntent ("Existing authorization must be updated or
// cancelled first"). That refusal is right once money is held, but it also
// fired when the customer's first attempt never got that far — a mistyped
// expiry date, a declined card — because Stripe leaves such an intent waiting
// for a payment method rather than failing it. The payment form's "Try again"
// then hit the refusal every time, so that booking could never be paid for.
// Found by booking a junk removal job in the browser on staging.
//
// An intent Stripe is still waiting on, for the amount the booking now costs,
// is simply handed back so the customer can finish paying with it. Anything
// else — held, captured, processing, or for a stale amount — still gets the
// original refusal.
// ---------------------------------------------------------------------------

const AWAITING_CUSTOMER: ReadonlySet<Stripe.PaymentIntent.Status> = new Set([
  "requires_payment_method", "requires_confirmation", "requires_action",
]);

export async function findReusableIntent(paymentIntentId: string, expectedAmountCents: number): Promise<Stripe.PaymentIntent | null> {
  const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
  if (!AWAITING_CUSTOMER.has(intent.status)) return null;
  if (intent.amount !== expectedAmountCents) return null;
  return intent;
}
