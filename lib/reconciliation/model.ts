/**
 * End-to-end money reconciliation model (pure). Encodes the platform's money
 * identity so it can be asserted for any completed job/load, including
 * accessorials and refunds, with ZERO variance. No DB/Stripe — this is the
 * arithmetic that the live paths (customer charge, settlement, refunds) must
 * agree with; the reconciliation TEST drives real code and checks it against
 * this model.
 *
 * THE INVARIANT (must hold for every completed transaction):
 *   customerCharged - providerPaid - platformRevenue == 0   (before Stripe fees)
 *
 * Stripe processing fees are a cost to the PLATFORM, deducted from platform
 * revenue — they never change what the customer is charged or the provider is
 * paid. So the reconciled identity including Stripe is:
 *   customerCharged - providerPaid - platformNet - stripeFee == 0
 *   where platformNet = platformRevenue - stripeFee.
 *
 * Refunds reduce customerCharged and the corresponding platform/provider
 * shares; a fully refunded line nets to zero on all three sides.
 */

export type Money = number; // integer cents

export type TransactionLine = {
  // Base fee model split (already verified elsewhere): the customer pays
  // customerBaseCents, the provider receives providerBaseCents, the platform
  // keeps the difference.
  customerBaseCents: Money;
  providerBaseCents: Money;
  // Accessorials, each already split into the three frozen amounts.
  accessorials: { customerChargeCents: Money; providerShareCents: Money; platformShareCents: Money }[];
  // Stripe processing fee on the captured customer charge (platform cost).
  stripeFeeCents: Money;
  // Refunds applied to this transaction, each with the customer/provider/
  // platform portions being reversed.
  refunds?: { customerCents: Money; providerCents: Money; platformCents: Money }[];
};

export type Reconciliation = {
  customerCharged: Money;
  providerPaid: Money;
  platformRevenue: Money; // gross, before Stripe fee
  stripeFee: Money;
  platformNet: Money; // platformRevenue - stripeFee
  variance: Money; // must be 0
  stripeVariance: Money; // must be 0
};

export function reconcile(line: TransactionLine): Reconciliation {
  const accCustomer = line.accessorials.reduce((s, a) => s + a.customerChargeCents, 0);
  const accProvider = line.accessorials.reduce((s, a) => s + a.providerShareCents, 0);
  const accPlatform = line.accessorials.reduce((s, a) => s + a.platformShareCents, 0);

  const refundCustomer = (line.refunds ?? []).reduce((s, r) => s + r.customerCents, 0);
  const refundProvider = (line.refunds ?? []).reduce((s, r) => s + r.providerCents, 0);
  const refundPlatform = (line.refunds ?? []).reduce((s, r) => s + r.platformCents, 0);

  const customerCharged = line.customerBaseCents + accCustomer - refundCustomer;
  const providerPaid = line.providerBaseCents + accProvider - refundProvider;

  // Platform gross revenue = base platform share + accessorial platform share
  // − refunded platform portion. Base platform share = customerBase −
  // providerBase (the fee-model invariant).
  const basePlatform = line.customerBaseCents - line.providerBaseCents;
  const platformRevenue = basePlatform + accPlatform - refundPlatform;

  const variance = customerCharged - providerPaid - platformRevenue;
  const platformNet = platformRevenue - line.stripeFeeCents;
  const stripeVariance = customerCharged - providerPaid - platformNet - line.stripeFeeCents;

  return {
    customerCharged,
    providerPaid,
    platformRevenue,
    stripeFee: line.stripeFeeCents,
    platformNet,
    variance,
    stripeVariance,
  };
}

/** True iff the transaction reconciles to $0.00 on both identities. */
export function reconcilesToZero(line: TransactionLine): boolean {
  const r = reconcile(line);
  return r.variance === 0 && r.stripeVariance === 0;
}
