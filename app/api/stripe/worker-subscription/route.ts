import { NextResponse } from "next/server";
import { z } from "zod";
import { stripe } from "@/lib/stripe";
import { prisma } from "@/lib/db";
import { isMoverSubscriptionWaived } from "@/lib/pricing";
import { requireRole, AuthError } from "@/lib/auth";

const schema = z.object({
  plan: z.enum(["MOVER", "DRIVER_BASIC", "OWNER_OPERATOR_PRO", "FLEET"]),
  fleetVehicleCount: z.number().int().min(1).optional(),
});

const priceEnv: Record<string, string> = {
  MOVER: "STRIPE_MOVER_SUBSCRIPTION_PRICE_ID",
  DRIVER_BASIC: "STRIPE_DRIVER_BASIC_PRICE_ID",
  OWNER_OPERATOR_PRO: "STRIPE_OWNER_OPERATOR_PRO_PRICE_ID",
  FLEET: "STRIPE_FLEET_PRICE_ID",
};

/** A mover can only ever be on the MOVER plan; a box-truck driver can't buy
 *  the labor-only mover plan; a semi driver can't under-subscribe to
 *  Driver Basic (that plan doesn't cover semi equipment at all). */
function planAllowedForWorker(workerType: string, plan: string): boolean {
  if (workerType === "MOVER") return plan === "MOVER";
  if (workerType === "BOX_TRUCK_DRIVER") return ["DRIVER_BASIC", "OWNER_OPERATOR_PRO", "FLEET"].includes(plan);
  if (workerType === "SEMI_DRIVER") return ["OWNER_OPERATOR_PRO", "FLEET"].includes(plan);
  return false;
}

export async function POST(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["MOVER", "DRIVER"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) {
    return NextResponse.json({ error: "Application URL is not configured." }, { status: 500 });
  }
  const successUrl = `${appUrl}/onboarding/driver?subscription=success`;
  const cancelUrl = `${appUrl}/onboarding/driver?subscription=canceled`;

  const worker = await prisma.workerProfile.findUnique({
    where: { userId: authed.userId },
    include: { user: true },
  });
  if (!worker) return NextResponse.json({ error: "Worker not found." }, { status: 404 });

  if (!planAllowedForWorker(worker.workerType, parsed.data.plan)) {
    return NextResponse.json({ error: "This subscription plan is not available for your worker type." }, { status: 403 });
  }

  if (
    parsed.data.plan === "MOVER" &&
    worker.subscriptionWaivedUntilFirstJob &&
    isMoverSubscriptionWaived(worker.completedJobs, worker.firstCompletedJobAt)
  ) {
    // The plan must still be saved even though billing is waived — the
    // onboarding evaluator checks subscriptionPlan !== null regardless of
    // whether payment is currently active, and nothing else would ever set
    // it for a waived mover. subscriptionStatus stays INCOMPLETE (not
    // ACTIVE) since no payment has actually happened yet.
    const updated = await prisma.workerProfile.update({
      where: { id: worker.id },
      data: { subscriptionPlan: "MOVER", subscriptionStatus: "INCOMPLETE" },
    });
    await prisma.auditLog.create({
      data: { actorId: authed.userId, action: "MOVER_PLAN_SELECTED_WITH_WAIVER", entityType: "WorkerProfile", entityId: worker.id, details: { plan: "MOVER" } },
    });
    return NextResponse.json({
      status: "WAIVED_UNTIL_FIRST_COMPLETED_JOB",
      amountDueCents: 0,
      plan: updated.subscriptionPlan,
      message: "The $19.95 mover subscription begins only after the first completed paid job.",
    });
  }

  const envName = priceEnv[parsed.data.plan];
  const priceId = process.env[envName];
  if (!priceId) return NextResponse.json({ error: `${envName} is not configured.` }, { status: 500 });

  const lineItems: { price: string; quantity: number }[] = [{ price: priceId, quantity: 1 }];
  const vehicleCount = parsed.data.fleetVehicleCount ?? 5;
  if (parsed.data.plan === "FLEET" && vehicleCount > 5) {
    const extraPrice = process.env.STRIPE_FLEET_EXTRA_VEHICLE_PRICE_ID;
    if (!extraPrice) return NextResponse.json({ error: "STRIPE_FLEET_EXTRA_VEHICLE_PRICE_ID is not configured." }, { status: 500 });
    lineItems.push({ price: extraPrice, quantity: vehicleCount - 5 });
  }

  // Resolve or create the worker's own Stripe Customer (billing profile for
  // their membership fee — distinct from stripeAccountId, their Connect
  // account for receiving payouts). The frontend never supplies this: a
  // client-controlled Stripe Customer ID here would let one worker bill
  // their subscription to another person's payment method.
  let stripeCustomerId = worker.stripeCustomerId;
  if (!stripeCustomerId) {
    const customer = await stripe.customers.create(
      { email: worker.user.email, name: `${worker.user.firstName} ${worker.user.lastName}`, metadata: { workerId: worker.id } },
      { idempotencyKey: `worker-customer:${worker.id}` },
    );
    stripeCustomerId = customer.id;
    await prisma.workerProfile.update({ where: { id: worker.id }, data: { stripeCustomerId } });
  }

  const metadata = { workerId: worker.id, plan: parsed.data.plan, fleetVehicleCount: String(vehicleCount) };

  const session = await stripe.checkout.sessions.create(
    {
      mode: "subscription",
      customer: stripeCustomerId,
      line_items: lineItems,
      success_url: successUrl,
      cancel_url: cancelUrl,
      allow_promotion_codes: true,
      // Metadata at BOTH levels, deliberately: the top-level session
      // metadata is what checkout.session.completed sees, and is the only
      // reliable link back to workerId at the moment checkout succeeds —
      // subscription_data.metadata alone (the old code) left the webhook
      // with nothing to query WorkerProfile.stripeSubscriptionId by, since
      // that field was never saved anywhere before later subscription
      // events tried to look it up.
      metadata,
      subscription_data: { metadata },
    },
    { idempotencyKey: `worker-subscription-checkout:${worker.id}:${parsed.data.plan}` },
  );
  return NextResponse.json({ status: "CHECKOUT_REQUIRED", url: session.url });
}
