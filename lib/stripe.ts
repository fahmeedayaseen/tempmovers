import Stripe from "stripe";
import { captureIntegrationAlert } from "@/lib/monitoring";

const stripeKey = process.env.STRIPE_SECRET_KEY;
if (!stripeKey) {
  throw new Error("STRIPE_SECRET_KEY is required — set it in .env.local (see .env.example).");
}

export const stripe = new Stripe(stripeKey, {
  apiVersion: "2025-08-27.basil",
});

/** Maps a Stripe PaymentIntent status to our PaymentStatus enum. requires_action
 *  and processing both map to REQUIRES_PAYMENT_METHOD — this app doesn't currently
 *  distinguish "needs customer action" from "not yet attempted" as separate
 *  states; both need the same next step (retry/resolve), just via different UI. */
export function mapStripeIntentStatus(status: Stripe.PaymentIntent.Status): "REQUIRES_PAYMENT_METHOD" | "PROCESSING" | "AUTHORIZED" | "CAPTURED" | "CANCELED" {
  switch (status) {
    case "succeeded":
      return "CAPTURED";
    case "requires_capture":
      return "AUTHORIZED";
    case "processing":
      return "PROCESSING";
    case "canceled":
      return "CANCELED";
    case "requires_payment_method":
    case "requires_confirmation":
    case "requires_action":
    default:
      return "REQUIRES_PAYMENT_METHOD";
  }
}

/** P1-06: previously `sub.status === "active" ? "ACTIVE" : "PAST_DUE"` —
 *  every non-active state (trialing, incomplete, incomplete_expired,
 *  paused, unpaid, canceled) collapsed into PAST_DUE, which could
 *  incorrectly grant or deny Billing Portal access depending on what
 *  access logic keys off that field elsewhere. Every real Stripe
 *  subscription status now maps to its own distinct value. */
export function mapStripeSubscriptionStatus(status: Stripe.Subscription.Status): "INCOMPLETE" | "INCOMPLETE_EXPIRED" | "TRIALING" | "ACTIVE" | "PAST_DUE" | "CANCELED" | "UNPAID" | "PAUSED" {
  switch (status) {
    case "incomplete":
      return "INCOMPLETE";
    case "incomplete_expired":
      return "INCOMPLETE_EXPIRED";
    case "trialing":
      return "TRIALING";
    case "active":
      return "ACTIVE";
    case "past_due":
      return "PAST_DUE";
    case "canceled":
      return "CANCELED";
    case "unpaid":
      return "UNPAID";
    case "paused":
      return "PAUSED";
    default:
      // Intended to be exhaustive against Stripe's current documented
      // statuses, but this environment can't run a full type-check
      // against the real Stripe SDK types to confirm that, and Stripe
      // could add a new status in the future either way. Previously
      // this silently fell back to PAST_DUE with no visibility at all —
      // fixed per reviewer feedback: still returns the same
      // conservative "needs attention" value (something has to be
      // returned), but now actually flags that an unrecognized status
      // occurred, so it gets reviewed rather than silently
      // miscategorized indefinitely.
      captureIntegrationAlert(`Unrecognized Stripe subscription status "${status}" — defaulted to PAST_DUE pending review.`, {
        area: "billing", stripeSubscriptionStatus: status,
      });
      return "PAST_DUE";
  }
}
