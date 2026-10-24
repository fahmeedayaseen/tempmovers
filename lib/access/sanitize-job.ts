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
