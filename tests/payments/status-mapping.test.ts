import { describe, it, expect } from "vitest";
import { mapStripeIntentStatus, mapStripeSubscriptionStatus } from "@/lib/stripe";

/**
 * P2-03 (partial): these two mapper functions are pure and need no
 * Stripe client or database mocking, unlike almost everything else this
 * audit covers — PaymentIntent creation, capture, webhook replay,
 * refunds, transfers, partner invoices, and settlements all need real
 * Stripe-client mocks plus database integration tests, none of which
 * exist yet. Covering the two easiest, highest-value pure functions
 * first, honestly, rather than claiming broader coverage this pass
 * doesn't actually have.
 */
describe("mapStripeIntentStatus", () => {
  it("maps succeeded to CAPTURED", () => {
    expect(mapStripeIntentStatus("succeeded")).toBe("CAPTURED");
  });
  it("maps requires_capture to AUTHORIZED — the actual P0-01 fix this guards against regressing", () => {
    expect(mapStripeIntentStatus("requires_capture")).toBe("AUTHORIZED");
  });
  it("maps processing to PROCESSING, not REQUIRES_PAYMENT_METHOD", () => {
    expect(mapStripeIntentStatus("processing")).toBe("PROCESSING");
  });
  it("maps canceled to CANCELED, not FAILED", () => {
    expect(mapStripeIntentStatus("canceled")).toBe("CANCELED");
  });
  it("maps every pre-confirmation status to REQUIRES_PAYMENT_METHOD", () => {
    expect(mapStripeIntentStatus("requires_payment_method")).toBe("REQUIRES_PAYMENT_METHOD");
    expect(mapStripeIntentStatus("requires_confirmation")).toBe("REQUIRES_PAYMENT_METHOD");
    expect(mapStripeIntentStatus("requires_action")).toBe("REQUIRES_PAYMENT_METHOD");
  });
});

describe("mapStripeSubscriptionStatus", () => {
  it("maps every real Stripe subscription status to its own distinct value — the P1-06 fix", () => {
    expect(mapStripeSubscriptionStatus("incomplete")).toBe("INCOMPLETE");
    expect(mapStripeSubscriptionStatus("incomplete_expired")).toBe("INCOMPLETE_EXPIRED");
    expect(mapStripeSubscriptionStatus("trialing")).toBe("TRIALING");
    expect(mapStripeSubscriptionStatus("active")).toBe("ACTIVE");
    expect(mapStripeSubscriptionStatus("past_due")).toBe("PAST_DUE");
    expect(mapStripeSubscriptionStatus("canceled")).toBe("CANCELED");
    expect(mapStripeSubscriptionStatus("unpaid")).toBe("UNPAID");
    expect(mapStripeSubscriptionStatus("paused")).toBe("PAUSED");
  });
  it("none of the non-active states collapse into PAST_DUE — the exact bug this replaced", () => {
    const nonActive = ["incomplete", "incomplete_expired", "trialing", "canceled", "unpaid", "paused"] as const;
    for (const status of nonActive) {
      expect(mapStripeSubscriptionStatus(status)).not.toBe("PAST_DUE");
    }
  });
});
