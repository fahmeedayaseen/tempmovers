import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { stripe } from "@/lib/stripe";

type Client = Prisma.TransactionClient | typeof prisma;

/**
 * A genuinely critical gap found during an end-to-end workflow review,
 * not a route-level audit: `stripe.customers.create()` was called in
 * exactly one place in this entire codebase — the WORKER subscription
 * route. Nothing anywhere ever created a Stripe customer for a
 * CUSTOMER (the person booking and paying for moving jobs or freight).
 * `CustomerProfile.stripeCustomerId` was referenced only in READ checks
 * ("No Stripe customer on file for this account" — job-payment-intent,
 * driver-payment-intent, detention charge) across three separate
 * routes, and never once WRITTEN. This meant a customer could register,
 * book a job, and would then be permanently unable to ever authorize
 * payment for it, through any code path in the system — not an edge
 * case, the primary path.
 *
 * This is exactly the class of break an end-to-end trace catches that
 * individual-route review doesn't: every route correctly handled what
 * to do WITH a stripeCustomerId, and correctly rejected its absence,
 * but nobody had built the piece that actually creates one.
 *
 * Idempotent: returns the existing ID if already set, only calls
 * Stripe when it's genuinely missing.
 */
export async function ensureStripeCustomer(client: Client, customerProfileId: string): Promise<string> {
  const customer = await client.customerProfile.findUnique({
    where: { id: customerProfileId },
    include: { user: true },
  });
  if (!customer) throw new Error(`CustomerProfile ${customerProfileId} not found.`);
  if (customer.stripeCustomerId) return customer.stripeCustomerId;

  const stripeCustomer = await stripe.customers.create(
    {
      email: customer.user.email,
      name: `${customer.user.firstName} ${customer.user.lastName}`,
      metadata: { customerProfileId: customer.id },
    },
    { idempotencyKey: `customer-profile:${customer.id}` },
  );

  await client.customerProfile.update({
    where: { id: customer.id },
    data: { stripeCustomerId: stripeCustomer.id },
  });

  return stripeCustomer.id;
}
