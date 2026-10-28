import { PrismaClient, UserRole, WorkerType, AccountStatus, SubscriptionPlan, SubscriptionStatus } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  await prisma.pricingRule.upsert({
    where: { marketCode: "US-DEFAULT" },
    update: {},
    create: {
      marketCode: "US-DEFAULT",
      minimumHours: 3,
      minimumMovers: 2,
      platformFeePerHourCents: 500,
      urgentFeeMode: "HOURLY_FEE",
      urgentPlatformFeePerHourCents: 700,
      customerBookingProtectionFeeCents: 995,
      waiveMoverSubscriptionUntilFirstJob: true,
      moverSubscriptionCents: 1995,
      driverBasicSubscriptionCents: 2995,
      ownerOperatorSubscriptionCents: 5995,
      fleetSubscriptionCents: 14900,
      boxTruckFeePerHourCents: 500,
      semiPlatformFeePercent: 5,
      semiPlatformFeeCapCents: 15000,
      fleetIncludedVehicles: 5,
      additionalFleetVehicleCents: 1500,
      urgentPremiumPercent: 20,
    },
  });

  const admin = await prisma.user.upsert({
    where: { email: "admin@tempmovers.com" },
    update: {},
    create: {
      email: "admin@tempmovers.com",
      firstName: "TempMovers",
      lastName: "Admin",
      role: UserRole.ADMIN,
      status: AccountStatus.ACTIVE,
      adminProfile: { create: { title: "Platform Administrator" } },
    },
  });

  await prisma.skill.createMany({
    data: [
      { name: "Loading" }, { name: "Unloading" }, { name: "Furniture assembly" },
      { name: "Heavy items" }, { name: "Box truck driving" }, { name: "Semi driving" },
    ],
    skipDuplicates: true,
  });

  await prisma.launchMarket.upsert({
    where: { marketCode: "INDY" },
    // Junk removal — VASRUE Digital Media, 28 Oct 2026: junk removal launches in Indianapolis only (junk spec §2).
    update: { publicBookingEnabled: true, workerRecruitingEnabled: true, freightEnabled: true, junkRemovalEnabled: true },
    create: {
      marketCode: "INDY", name: "Indianapolis Metro", state: "IN",
      zipCodes: ["46201","46204","46220","46032","46037","46060","46142","46168","46123","46112"],
      publicBookingEnabled: true, workerRecruitingEnabled: true, freightEnabled: true, junkRemovalEnabled: true,
    },
  });

  // Customer credit and mover bonus are separate programs, even though both key off
  // "first job" — do not conflate them into a single record or a single type.
  const bonuses = [
    ["CUSTOMER_FIRST_BOOKING_25", "Customer first booking credit", "CUSTOMER_FIRST_BOOKING_CREDIT", "CUSTOMER", 2500, 1],
    ["MOVER_FIRST_JOB_25", "Mover first job completion bonus", "MOVER_FIRST_JOB_BONUS", "MOVER", 2500, 1],
    ["THREE_5STAR_25", "Three five-star jobs bonus", "THREE_FIVE_STAR_JOBS_BONUS", "MOVER", 2500, 3],
    ["MOVER_REFERRAL_50", "Mover referral bonus", "MOVER_REFERRAL_BONUS", "MOVER", 5000, 5],
    ["DRIVER_REFERRAL_75", "Driver referral bonus", "DRIVER_REFERRAL_BONUS", "DRIVER", 7500, 3],
    ["PARTNER_REFERRAL_25", "Partner referral credit", "PARTNER_REFERRAL_CREDIT", "PARTNER", 2500, 1],
  ] as const;
  for (const [code,name,type,recipientKind,amountCents,qualificationCount] of bonuses) {
    await prisma.bonusProgram.upsert({ where:{code}, update:{}, create:{code,name,type,recipientKind,amountCents,qualificationCount,marketCode:"INDY"} });
  }

  const customerUser = await prisma.user.upsert({
    where: { email: "customer@example.com" },
    update: {},
    create: {
      email: "customer@example.com", firstName: "Jordan", lastName: "Blake",
      role: UserRole.CUSTOMER, status: AccountStatus.ACTIVE,
      customerProfile: { create: { type: "INDIVIDUAL" } },
    },
    include: { customerProfile: true },
  });

  const moverUser = await prisma.user.upsert({
    where: { email: "marcus.reed@example.com" },
    update: {},
    create: {
      email: "marcus.reed@example.com", firstName: "Marcus", lastName: "Reed",
      role: UserRole.MOVER, status: AccountStatus.ACTIVE,
      workerProfile: {
        create: {
          workerType: WorkerType.MOVER, hourlyEarningsCents: 3200, homeZip: "46220", acceptingJobs: true,
          legalName: "Marcus Reed", dateOfBirth: new Date("1990-04-12"),
          onboardingStatus: "COMPLETE", overallVerificationStatus: "APPROVED", operationalStatus: "ACTIVE",
          subscriptionPlan: SubscriptionPlan.MOVER, subscriptionStatus: SubscriptionStatus.ACTIVE,
          stripeConnectOnboarded: true, stripeChargesEnabled: true, stripePayoutsEnabled: true,
          approvedAt: new Date(),
        },
      },
    },
    include: { workerProfile: true },
  });

  const driverUser = await prisma.user.upsert({
    where: { email: "deshawn.porter@example.com" },
    update: {},
    create: {
      email: "deshawn.porter@example.com", firstName: "DeShawn", lastName: "Porter",
      role: UserRole.DRIVER, status: AccountStatus.ACTIVE,
      workerProfile: {
        create: {
          workerType: WorkerType.BOX_TRUCK_DRIVER, hourlyEarningsCents: 6000, homeZip: "46204", acceptingJobs: true,
          vehicleVerificationStatus: "APPROVED", insuranceVerificationStatus: "APPROVED", dotMcVerificationStatus: "NOT_REQUIRED",
          legalName: "DeShawn Porter", dateOfBirth: new Date("1988-09-03"),
          onboardingStatus: "COMPLETE", overallVerificationStatus: "APPROVED", operationalStatus: "ACTIVE",
          subscriptionPlan: SubscriptionPlan.DRIVER_BASIC, subscriptionStatus: SubscriptionStatus.ACTIVE,
          stripeConnectOnboarded: true, stripeChargesEnabled: true, stripePayoutsEnabled: true,
          approvedAt: new Date(),
        },
      },
    },
    include: { workerProfile: true },
  });

  const partnerOrg = customerUser.customerProfile
    ? await prisma.partnerOrganization.upsert({
        where: { referralCode: "CIRCLE-CITY-REST" },
        update: {},
        create: {
          customerId: customerUser.customerProfile.id,
          type: "RESTORATION_COMPANY",
          legalName: "Circle City Restoration LLC",
          displayName: "Circle City Restoration",
          referralCode: "CIRCLE-CITY-REST",
          monthlyInvoicing: true,
        },
      })
    : null;

  // Load board demo data spanning every visibility level. Only the fields in the
  // PUBLIC-SAFE group of CarrierRoute are ever meant to reach an unauthenticated caller.
  const loads = [
    {
      title: "Box truck — Indianapolis to Speedway", visibility: "PUBLIC_PREVIEW" as const,
      originCity: "Indianapolis", originState: "IN", originZip: "46204",
      destinationCity: "Speedway", destinationState: "IN", equipmentType: "BOX_TRUCK" as const,
      pickupDate: new Date("2026-07-22"), estimatedHoursOrMiles: "6 hours", stopCount: 2,
      grossCarrierCents: 36000, platformFeeCents: 3000, isLocalRoute: true,
    },
    {
      title: "Semi — Indianapolis to Chicago", visibility: "PUBLIC_PREVIEW" as const,
      originCity: "Indianapolis", originState: "IN", originZip: "46204",
      destinationCity: "Chicago", destinationState: "IL", equipmentType: "SEMI_TRACTOR_TRAILER" as const,
      pickupDate: new Date("2026-07-24"), estimatedHoursOrMiles: "~185 mi", stopCount: 1,
      grossCarrierCents: 200000, platformFeeCents: 10000, cdlRequired: true,
    },
    {
      title: "Semi — Indianapolis regional (confidential shipper)", visibility: "PRIVATE_CONFIDENTIAL" as const,
      originCity: "Indianapolis", originState: "IN", originZip: "46204",
      destinationCity: "Regional — undisclosed", destinationState: "--", equipmentType: "SEMI_TRACTOR_TRAILER" as const,
      pickupDate: new Date("2026-07-26"), estimatedHoursOrMiles: "~310 mi", stopCount: 1,
      grossCarrierCents: 240000, platformFeeCents: 12000, cdlRequired: true,
      exactPickupAddress: "4500 W Bradbury Ave, Indianapolis, IN 46241",
      shipperContactName: "Ops Desk", shipperContactPhone: "317-555-0148",
      commodityDescription: "Retail electronics — high theft risk",
      partnerOrganizationId: partnerOrg?.id,
    },
  ];
  for (const load of loads) {
    const existing = await prisma.carrierRoute.findFirst({ where: { title: load.title } });
    if (!existing) await prisma.carrierRoute.create({ data: load });
  }

  for (const [key, enabled, description] of [
    ["MOVING_LABOR_ENABLED", true, "Labor-only moving marketplace"],
    ["LOCAL_BOX_TRUCK_ENABLED", true, "Local box-truck routes"],
    ["INTERSTATE_FREIGHT_ENABLED", false, "Enable only after authority review"],
    ["HOUSEHOLD_GOODS_BROKERAGE_ENABLED", false, "Enable only after authority review"],
    ["EXTERNAL_LOAD_BOARDS_ENABLED", false, "DAT/Truckstop/Uber Freight adapters"],

    // -----------------------------------------------------------------------
    // BLOCK-03 — VASRUE Digital Media, 24 October 2026.
    //
    // The eight freight-brokerage capability flags the application actually
    // reads were never seeded. Verified empirically against a live database
    // before this change: the seed created five unrelated flags and none of
    // these eight, so every brokerage capability check resolved against a row
    // that did not exist.
    //
    // All eight are seeded false on purpose. Freight brokerage stays dormant
    // until the DOT operating authority, MC number and BMC-84 bond are in
    // place; seeding them false is what makes that gate explicit and auditable
    // rather than incidental. Flipping any one of them early would expose
    // brokerage behaviour the business is not yet licensed to perform.
    //
    // Keys were taken from the capability checks in the application code, not
    // from a document, so they match what is actually read at runtime.
    // -----------------------------------------------------------------------
    ["FREIGHT_BROKERAGE_ENABLED", false, "Master brokerage switch — requires DOT authority, MC number and BMC-84 bond"],
    ["LOAD_POSTING_ENABLED", false, "Posting brokered loads — requires brokerage authority"],
    ["CARRIER_LOAD_ACCEPTANCE_ENABLED", false, "Carriers accepting brokered loads — requires brokerage authority"],
    ["DISPATCH_SERVICES_ENABLED", false, "Dispatch-only services on behalf of carriers"],
    ["DIRECT_SHIPPER_QUOTING_ENABLED", false, "Quoting direct shippers — requires brokerage authority"],
    ["CARRIER_PAYMENTS_ENABLED", false, "Carrier settlement payouts — also blocked pending payment provider selection"],
    ["BROKER_CARRIER_AGREEMENTS_ENABLED", false, "Broker-carrier agreement execution — requires brokerage authority"],
    ["RATE_CONFIRMATION_GENERATION_ENABLED", false, "Rate confirmation generation — requires brokerage authority"],
  ] as const) await prisma.featureFlag.upsert({where:{key},update:{enabled,description},create:{key,enabled,description}});

  console.log({ admin: admin.email });
}

main().finally(() => prisma.$disconnect());
