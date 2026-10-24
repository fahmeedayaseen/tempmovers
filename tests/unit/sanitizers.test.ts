import { describe, it, expect } from "vitest";
import { SANITIZED_JOB_SELECT } from "@/lib/access/sanitize-job";
import { SANITIZED_LOAD_SELECT } from "@/lib/access/sanitize-load";

/**
 * The release-blocker requirement from the Afterpay/compliance handoff:
 * "an unapproved or unassigned account cannot retrieve exact addresses,
 * contact details, documents, or private instructions through any API
 * route." This test proves it at the structural level for the two
 * sanitizer field-selection objects every job/load list endpoint uses —
 * if a forbidden field is ever added to either selector, this test fails
 * the build rather than silently shipping a data leak.
 */

const FORBIDDEN_JOB_FIELDS = [
  "customerId", "addressId", "description", "latitude", "longitude",
  "platformFeePerHourCents", "urgentPlatformFeePerHourCents", "stripePaymentIntentId", "paymentStatus",
  "estimatedSubtotalCents", "estimatedPlatformFeeCents", "estimatedTotalCents",
];

const FORBIDDEN_LOAD_FIELDS = [
  "exactPickupAddress", "exactDeliveryAddress", "shipperContactName", "shipperContactPhone",
  "commodityDescription", "accessCode", "declaredValueCents", "originLatitude", "originLongitude",
  "destinationLatitude", "destinationLongitude", "postedByUserId", "partnerOrganizationId",
];

describe("SANITIZED_JOB_SELECT", () => {
  it("never includes any forbidden field", () => {
    for (const field of FORBIDDEN_JOB_FIELDS) {
      expect(field in SANITIZED_JOB_SELECT).toBe(false);
    }
  });

  it("includes the fields a sanitized preview actually needs", () => {
    expect(SANITIZED_JOB_SELECT).toHaveProperty("title");
    expect(SANITIZED_JOB_SELECT).toHaveProperty("startsAt");
    expect(SANITIZED_JOB_SELECT).toHaveProperty("customerMoverRateCents");
  });
});

describe("SANITIZED_LOAD_SELECT", () => {
  it("never includes any forbidden field", () => {
    for (const field of FORBIDDEN_LOAD_FIELDS) {
      expect(field in SANITIZED_LOAD_SELECT).toBe(false);
    }
  });

  it("includes the fields a sanitized preview actually needs", () => {
    expect(SANITIZED_LOAD_SELECT).toHaveProperty("originCity");
    expect(SANITIZED_LOAD_SELECT).toHaveProperty("destinationCity");
    expect(SANITIZED_LOAD_SELECT).toHaveProperty("grossCarrierCents");
  });
});
