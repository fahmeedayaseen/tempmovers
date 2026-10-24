/**
 * Launch Readiness metrics assembler (launch spec §6). PURE — takes real
 * counts gathered by the route and shapes them into the dashboard payload.
 * Kept pure so the shaping/derivation is testable; the route supplies numbers
 * from actual DB queries (acceptance criterion: real data, not placeholders).
 *
 * Fields the platform does not yet track are returned null and the UI labels
 * them "Not tracked" — never a fabricated value (same honesty rule as the
 * integration health dashboard).
 */
export type ReadinessCounts = {
  // supply
  approvedMovers: number | null;
  activeMovers: number | null;
  approvedDrivers: number | null;
  activeDrivers: number | null;
  approvedCarriers: number | null;
  carriersWithCurrentInsurance: number | null;
  // demand
  registeredCustomers: number | null;
  recurringCustomers: number | null;
  signedPropertyPartners: number | null;
  signedShippers: number | null;
  openBookingRequests: number | null;
  waitlistCount: number | null;
  // platform
  stripePaymentSuccessRate: number | null; // 0..1
  failedPaymentCount: number | null;
  openProductionDefects: number | null;
  documentVerificationBacklog: number | null;
  migrationStatus: string | null;
  lastSuccessfulDeployment: string | null;
  lastEndToEndTestDate: string | null;
  // performance (post-launch)
  jobsCompleted: number | null;
  cancellationRate: number | null;
  averageRating: number | null;
  grossBookingValueCents: number | null;
  platformRevenueCents: number | null;
  workerPayoutCents: number | null;
};

export type ReadinessDashboard = {
  supply: Record<string, number | null>;
  demand: Record<string, number | null>;
  platform: Record<string, number | string | null>;
  performance: Record<string, number | null>;
};

export function assembleReadinessDashboard(c: ReadinessCounts): ReadinessDashboard {
  return {
    supply: {
      approvedMovers: c.approvedMovers,
      activeMovers: c.activeMovers,
      approvedDrivers: c.approvedDrivers,
      activeDrivers: c.activeDrivers,
      approvedCarriers: c.approvedCarriers,
      carriersWithCurrentInsurance: c.carriersWithCurrentInsurance,
    },
    demand: {
      registeredCustomers: c.registeredCustomers,
      recurringCustomers: c.recurringCustomers,
      signedPropertyPartners: c.signedPropertyPartners,
      signedShippers: c.signedShippers,
      openBookingRequests: c.openBookingRequests,
      waitlistCount: c.waitlistCount,
    },
    platform: {
      stripePaymentSuccessRate: c.stripePaymentSuccessRate,
      failedPaymentCount: c.failedPaymentCount,
      openProductionDefects: c.openProductionDefects,
      documentVerificationBacklog: c.documentVerificationBacklog,
      migrationStatus: c.migrationStatus,
      lastSuccessfulDeployment: c.lastSuccessfulDeployment,
      lastEndToEndTestDate: c.lastEndToEndTestDate,
    },
    performance: {
      jobsCompleted: c.jobsCompleted,
      cancellationRate: c.cancellationRate,
      averageRating: c.averageRating,
      grossBookingValueCents: c.grossBookingValueCents,
      platformRevenueCents: c.platformRevenueCents,
      workerPayoutCents: c.workerPayoutCents,
    },
  };
}
