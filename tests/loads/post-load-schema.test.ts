import { describe, it, expect } from "vitest";
import { postLoadSchema } from "@/lib/loads/post-load-schema";

const baseFields = {
  title: "Test load", originCity: "Indianapolis", originState: "IN",
  destinationCity: "Chicago", destinationState: "IL",
  pickupDate: new Date().toISOString(), estimatedHoursOrMiles: "4 hrs",
};

describe("postLoadSchema — owner-operator vs. driver-only enforcement", () => {
  it("accepts a valid owner-operator box-truck submission (flat-rate)", () => {
    const result = postLoadSchema.safeParse({
      ...baseFields, serviceType: "OWNER_OPERATOR_BOX_TRUCK", equipmentType: "BOX_TRUCK",
      pricingModel: "FLAT_RATE", driverPayoutCents: 40000,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an owner-operator box-truck submission that includes hourly fields", () => {
    // The whole point of the discriminated union: driverHourlyRateCents/
    // estimatedHours aren't even valid keys on this branch — Zod strips or
    // rejects them, they can never sneak an hourly rate into a flat-rate load.
    const result = postLoadSchema.safeParse({
      ...baseFields, serviceType: "OWNER_OPERATOR_BOX_TRUCK", equipmentType: "BOX_TRUCK",
      pricingModel: "HOURLY", driverHourlyRateCents: 6000, estimatedHours: 4,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an owner-operator box-truck submission with no driverPayoutCents", () => {
    const result = postLoadSchema.safeParse({
      ...baseFields, serviceType: "OWNER_OPERATOR_BOX_TRUCK", equipmentType: "BOX_TRUCK", pricingModel: "FLAT_RATE",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a valid owner-operator semi submission (flat-rate)", () => {
    const result = postLoadSchema.safeParse({
      ...baseFields, serviceType: "OWNER_OPERATOR_SEMI", equipmentType: "SEMI_TRACTOR_TRAILER",
      pricingModel: "FLAT_RATE", routeGrossCents: 200000,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a semi submission claiming HOURLY pricing", () => {
    const result = postLoadSchema.safeParse({
      ...baseFields, serviceType: "OWNER_OPERATOR_SEMI", equipmentType: "SEMI_TRACTOR_TRAILER",
      pricingModel: "HOURLY", routeGrossCents: 200000,
    });
    expect(result.success).toBe(false);
  });

  it("accepts HOURLY pricing only for the explicit driver-only service type", () => {
    const result = postLoadSchema.safeParse({
      ...baseFields, serviceType: "CUSTOMER_SUPPLIED_TRUCK_DRIVER_ONLY", equipmentType: "BOX_TRUCK",
      pricingModel: "HOURLY", driverHourlyRateCents: 6000, estimatedHours: 4,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a driver-only submission missing the required hourly fields", () => {
    const result = postLoadSchema.safeParse({
      ...baseFields, serviceType: "CUSTOMER_SUPPLIED_TRUCK_DRIVER_ONLY", equipmentType: "BOX_TRUCK", pricingModel: "HOURLY",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unrecognized serviceType entirely", () => {
    const result = postLoadSchema.safeParse({
      ...baseFields, serviceType: "SOMETHING_ELSE", equipmentType: "BOX_TRUCK", driverPayoutCents: 40000,
    });
    expect(result.success).toBe(false);
  });

  it("defaults detention fields to the standard 60-minute/$0 baseline when omitted", () => {
    const result = postLoadSchema.safeParse({
      ...baseFields, serviceType: "OWNER_OPERATOR_BOX_TRUCK", equipmentType: "BOX_TRUCK",
      pricingModel: "FLAT_RATE", driverPayoutCents: 40000,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.waitTimeIncludedMinutes).toBe(60);
      expect(result.data.waitTimeRateCents).toBe(0);
    }
  });

  it("accepts explicit detention configuration", () => {
    const result = postLoadSchema.safeParse({
      ...baseFields, serviceType: "OWNER_OPERATOR_BOX_TRUCK", equipmentType: "BOX_TRUCK",
      pricingModel: "FLAT_RATE", driverPayoutCents: 40000,
      waitTimeIncludedMinutes: 90, waitTimeRateCents: 4000,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.waitTimeIncludedMinutes).toBe(90);
      expect(result.data.waitTimeRateCents).toBe(4000);
    }
  });
});
