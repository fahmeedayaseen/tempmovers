/**
 * The canonical "safe to show a non-owning worker" field list for a moving
 * job. Unlike load sanitization (which had an existing, correct precedent
 * to extract from), this is net-new: GET /api/jobs had no sanitization or
 * even authentication at all before this pass — see the README note on
 * this fix.
 *
 * Deliberately excludes: exact address (Job.address, Job.latitude/
 * longitude — precise GPS, not just street text), customer identity,
 * description (may contain private notes), internal fee/margin fields
 * (platformFeePerHourCents, estimated*Cents beyond the mover-facing rate,
 * Stripe identifiers, paymentStatus).
 */
export const SANITIZED_JOB_SELECT = {
  id: true, title: true, type: true, status: true, startsAt: true,
  estimatedHours: true, minimumHours: true, moversRequired: true, driversRequired: true,
  customerMoverRateCents: true,
  market: { select: { name: true, state: true } },
} as const;

// Junk removal — VASRUE Digital Media, 28 Oct 2026. What a worker browsing the junk board
// may see of a junk job before taking it: what is being hauled, how hard it is,
// and what each seat pays. Never the customer's photos or notes, the address,
// or the platform's take.
export const SANITIZED_JUNK_DETAIL_SELECT = {
  pricingMode: true, volumeTier: true, items: true, itemCategories: true, itemLocation: true,
  hasHeavyItems: true, specialItems: true, helpersRequired: true, haulerShareCents: true, helperShareCents: true,
} as const;

/** The worker job feed: the sanitized job plus, on junk jobs only, the sanitized junk detail. */
export const SANITIZED_JOB_FEED_SELECT = {
  ...SANITIZED_JOB_SELECT,
  junkRemovalDetail: { select: SANITIZED_JUNK_DETAIL_SELECT },
} as const;
