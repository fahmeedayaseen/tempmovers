import { z } from "zod";

const baseLoadFields = {
  title: z.string().min(3),
  visibility: z.enum(["PUBLIC_PREVIEW", "VERIFIED_CARRIERS_ONLY", "PREFERRED_NETWORK", "PRIVATE_CONFIDENTIAL", "INTERNAL_DRAFT"]).default("PUBLIC_PREVIEW"),
  originCity: z.string().min(1), originState: z.string().length(2), originZip: z.string().optional(),
  destinationCity: z.string().min(1), destinationState: z.string().length(2),
  pickupDate: z.string().datetime(),
  estimatedHoursOrMiles: z.string().min(1),
  stopCount: z.number().int().nonnegative().default(0),
  liftgateRequired: z.boolean().default(false),
  cdlRequired: z.boolean().default(false),
  isLocalRoute: z.boolean().default(false),
  partnerOrganizationId: z.string().cuid().optional(),
  // Sensitive fields — stored, but never returned by GET /api/loads.
  exactPickupAddress: z.string().optional(),
  exactDeliveryAddress: z.string().optional(),
  shipperContactName: z.string().optional(),
  shipperContactPhone: z.string().optional(),
  commodityDescription: z.string().optional(),
  accessCode: z.string().optional(),
  waitTimeIncludedMinutes: z.number().int().nonnegative().default(60),
  waitTimeRateCents: z.number().int().nonnegative().default(0),
};

// Discriminated on serviceType, not equipmentType alone — this is the
// actual enforcement that HOURLY pricing can never be selected for a
// normal owner-operator load. Each branch only accepts the financial
// fields that are valid for it; a box-truck owner-operator submission
// literally cannot include driverHourlyRateCents, and an hourly
// driver-only submission cannot include driverPayoutCents.
//
// Extracted into its own file (rather than defined inline in the route)
// specifically so it's importable from tests without spinning up the
// route handler — see tests/loads/post-load-schema.test.ts.
export const postLoadSchema = z.discriminatedUnion("serviceType", [
  z.object({
    ...baseLoadFields,
    serviceType: z.literal("OWNER_OPERATOR_BOX_TRUCK"),
    equipmentType: z.literal("BOX_TRUCK"),
    pricingModel: z.literal("FLAT_RATE").default("FLAT_RATE"),
    driverPayoutCents: z.number().int().positive(),
    accessorialsCents: z.number().int().nonnegative().default(0),
  }),
  z.object({
    ...baseLoadFields,
    serviceType: z.literal("OWNER_OPERATOR_SEMI"),
    equipmentType: z.enum(["SEMI_TRACTOR", "SEMI_TRACTOR_TRAILER"]),
    pricingModel: z.literal("FLAT_RATE").default("FLAT_RATE"),
    routeGrossCents: z.number().int().positive(),
  }),
  z.object({
    ...baseLoadFields,
    serviceType: z.literal("CUSTOMER_SUPPLIED_TRUCK_DRIVER_ONLY"),
    equipmentType: z.literal("BOX_TRUCK"),
    pricingModel: z.literal("HOURLY"),
    driverHourlyRateCents: z.number().int().positive(),
    estimatedHours: z.number().positive(),
  }),
]);
