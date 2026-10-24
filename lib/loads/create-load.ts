import { prisma } from "@/lib/db";
import type { z } from "zod";
import type { postLoadSchema } from "@/lib/loads/post-load-schema";
import type { LoadBoardProvider } from "@prisma/client";
import { calculateBoxTruckQuote, calculateBoxTruckLoadQuote, calculateSemiLoadQuote } from "@/lib/pricing";
import { resolveActivePricingRule } from "@/lib/pricing-rules";
import { geocodeAddress, GeocodingNotConfiguredError } from "@/lib/geocoding";

/**
 * Shared load-creation service. The single money path for creating a freight
 * load, used by BOTH POST /api/loads (native post) and POST /api/loads/import
 * (dispatcher-entered external load). Centralizing it means internal and
 * imported loads price IDENTICALLY — the fee-model quote can never diverge by
 * entry channel.
 *
 * `provenance` tags an imported load with its source board + external id +
 * MANUAL_IMPORT sync status; omitted for a native post (defaults to INTERNAL).
 */
export type LoadInput = z.infer<typeof postLoadSchema>;

export type LoadProvenance = {
  sourceProvider: LoadBoardProvider;
  externalLoadId: string;
};

export type CreateLoadResult =
  | { ok: true; load: { id: string; title: string; visibility: string; status: string; createdAt: Date } }
  | { ok: false; status: number; error: string };

export async function createCarrierRouteLoad(params: {
  input: LoadInput;
  postedByUserId: string;
  postedByRole: string;
  provenance?: LoadProvenance;
}): Promise<CreateLoadResult> {
  const { input, postedByUserId, postedByRole, provenance } = params;

  if (input.partnerOrganizationId) {
    const membership = await prisma.partnerMember.findFirst({
      where: { partnerId: input.partnerOrganizationId, userId: postedByUserId, canPostJobs: true },
    });
    if (!membership && postedByRole !== "ADMIN") {
      return { ok: false, status: 403, error: "You are not authorized to post for this partner organization." };
    }
  }

  const originMarket = await prisma.launchMarket.findFirst({
    where: { state: input.originState, zipCodes: input.originZip ? { has: input.originZip } : undefined, freightEnabled: true },
  });
  if (!originMarket) {
    return { ok: false, status: 409, error: "Freight service is not active in the origin market." };
  }
  const destinationMarket = await prisma.launchMarket.findFirst({ where: { state: input.destinationState } });
  const originTerritory = input.originZip
    ? await prisma.territory.findFirst({ where: { marketId: originMarket.id, zipCodes: { has: input.originZip }, status: "ACTIVE" } })
    : null;

  let grossCarrierCents: number;
  let platformFeeCents: number;
  let customerTotalCents: number;
  let grossLoadAmountCents: number;
  let accessorialsCents = 0;
  const pricingModel = input.pricingModel;

  const resolvedPricing = await resolveActivePricingRule(originMarket.id, originTerritory?.id ?? null);
  const semiFeeModel = resolvedPricing.semiFeeModel;
  const freightBoxTruckFeeModel = resolvedPricing.freightBoxTruckFeeModel;

  if (input.serviceType === "OWNER_OPERATOR_SEMI") {
    const quote = calculateSemiLoadQuote(input.routeGrossCents, semiFeeModel);
    grossCarrierCents = quote.carrierPayoutCents;
    platformFeeCents = quote.platformFeeCents;
    customerTotalCents = quote.customerTotalCents;
    grossLoadAmountCents = quote.routeGrossCents;
  } else if (input.serviceType === "CUSTOMER_SUPPLIED_TRUCK_DRIVER_ONLY") {
    const quote = calculateBoxTruckQuote({ driverHourlyRateCents: input.driverHourlyRateCents, estimatedHours: input.estimatedHours });
    grossCarrierCents = quote.driverGrossCents;
    platformFeeCents = quote.platformFeeCents;
    customerTotalCents = quote.totalCents;
    grossLoadAmountCents = quote.driverGrossCents;
  } else {
    const quote = calculateBoxTruckLoadQuote({ driverPayoutCents: input.driverPayoutCents, accessorialsCents: input.accessorialsCents, feeModel: freightBoxTruckFeeModel });
    grossCarrierCents = quote.carrierPayoutCents;
    platformFeeCents = quote.platformFeeCents;
    accessorialsCents = quote.accessorialsCents;
    customerTotalCents = quote.customerTotalCents;
    grossLoadAmountCents = input.driverPayoutCents;
  }

  let originLatitude: number | null = null;
  let originLongitude: number | null = null;
  let destinationLatitude: number | null = null;
  let destinationLongitude: number | null = null;
  let needsManualGeoReview = false;
  try {
    const originGeo = await geocodeAddress(`${input.originCity}, ${input.originState} ${input.originZip ?? ""}`.trim());
    if (originGeo) { originLatitude = originGeo.latitude; originLongitude = originGeo.longitude; }
    const destGeo = await geocodeAddress(`${input.destinationCity}, ${input.destinationState}`);
    if (destGeo) { destinationLatitude = destGeo.latitude; destinationLongitude = destGeo.longitude; }
  } catch (e) {
    if (!(e instanceof GeocodingNotConfiguredError)) throw e;
    needsManualGeoReview = true;
  }

  const load = await prisma.carrierRoute.create({
    data: {
      title: input.title, visibility: input.visibility, equipmentType: input.equipmentType,
      originCity: input.originCity, originState: input.originState, originZip: input.originZip,
      originMarketId: originMarket.id, originTerritoryId: originTerritory?.id,
      originLatitude, originLongitude, needsManualGeoReview,
      destinationCity: input.destinationCity, destinationState: input.destinationState,
      destinationMarketId: destinationMarket?.id,
      destinationLatitude, destinationLongitude,
      pickupDate: new Date(input.pickupDate), estimatedHoursOrMiles: input.estimatedHoursOrMiles,
      stopCount: input.stopCount, liftgateRequired: input.liftgateRequired, cdlRequired: input.cdlRequired,
      isLocalRoute: input.isLocalRoute, grossCarrierCents, platformFeeCents, pricingModel, serviceType: input.serviceType, accessorialsCents,
      feeModel: input.serviceType === "OWNER_OPERATOR_SEMI" ? semiFeeModel : input.serviceType === "OWNER_OPERATOR_BOX_TRUCK" ? freightBoxTruckFeeModel : "ADD_TO_CUSTOMER",
      grossLoadAmountCents, carrierNetPayoutCents: grossCarrierCents, customerTotalCents,
      partnerOrganizationId: input.partnerOrganizationId, postedByUserId,
      exactPickupAddress: input.exactPickupAddress, exactDeliveryAddress: input.exactDeliveryAddress,
      shipperContactName: input.shipperContactName, shipperContactPhone: input.shipperContactPhone,
      commodityDescription: input.commodityDescription, accessCode: input.accessCode,
      waitTimeIncludedMinutes: input.waitTimeIncludedMinutes, waitTimeRateCents: input.waitTimeRateCents,
      requiresDotMcVerification: input.serviceType === "OWNER_OPERATOR_SEMI",
      // Provenance: imported loads carry their source board + external id.
      ...(provenance ? { sourceProvider: provenance.sourceProvider, externalLoadId: provenance.externalLoadId, externalSyncStatus: "MANUAL_IMPORT" as const } : {}),
    },
    select: { id: true, title: true, visibility: true, status: true, createdAt: true },
  });

  return { ok: true, load };
}
