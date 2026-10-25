import { NextResponse } from "next/server";
import Stripe from "stripe";
import { stripe, mapStripeSubscriptionStatus } from "@/lib/stripe";
import { prisma } from "@/lib/db";
import { recoverBonusesForQualifyingEntity } from "@/lib/bonus-ledger";
import { queueNotification } from "@/lib/notifications";
import { subscriptionConfirmationTemplate, subscriptionCancellationTemplate, paymentReceiptTemplate, refundNoticeTemplate, payoutStatusTemplate, tipReceivedTemplate } from "@/lib/email/templates/payments";
import { captureIntegrationAlert } from "@/lib/monitoring";

// ---------------------------------------------------------------------------
// BLOCK-05 — VASRUE Digital Media, 24 Oct 2026.
// Stripe's Basil API removed Invoice.subscription and moved the reference to
// Invoice.parent.subscription_details.subscription. lib/stripe.ts targets
// "2025-08-27.basil", so Basil is the correct shape to read here.
//
// Worth recording why this is NOT dependency drift, since that was the obvious
// first explanation: the hypothesis was tested by pinning the tree to the
// lockfile's own versions, which made the error count worse (34 -> 38) and
// left these nine untouched. It is a genuine upstream API migration.
//
// Centralised in one helper because the same read happens in both the
// invoice.paid and invoice.payment_failed branches, and a subscription id read
// wrongly in one branch but not the other would desynchronise a worker's
// billing state rather than fail visibly.
// ---------------------------------------------------------------------------
function invoiceSubscriptionId(inv: Stripe.Invoice): string | null {
  const sub = inv.parent?.subscription_details?.subscription ?? null;
  if (!sub) return null;
  return typeof sub === "string" ? sub : sub.id;
}
import { attemptTipAllocation } from "@/lib/tip-split";

/** Maps Stripe's actual payment method type (and wallet, for cards) to our
 *  ScreeningPaymentProvider enum — this is what replaces the old hardcoded
 *  "STRIPE" value with what the applicant genuinely used. */
function resolveScreeningPaymentProvider(input: { paymentMethodType?: string | null; walletType?: string | null }):
  | "STRIPE_CARD" | "APPLE_PAY" | "GOOGLE_PAY" | "CASH_APP_PAY" | "LINK"
  | "AFTERPAY_CLEARPAY" | "KLARNA" | "AFFIRM" | "OTHER_STRIPE" {
  const { paymentMethodType, walletType } = input;

  if (paymentMethodType === "afterpay_clearpay") return "AFTERPAY_CLEARPAY";
  if (paymentMethodType === "cashapp") return "CASH_APP_PAY";
  if (paymentMethodType === "klarna") return "KLARNA";
  if (paymentMethodType === "affirm") return "AFFIRM";
  if (paymentMethodType === "link") return "LINK";
  if (walletType === "apple_pay") return "APPLE_PAY";
  if (walletType === "google_pay") return "GOOGLE_PAY";
  if (paymentMethodType === "card") return "STRIPE_CARD";
  return "OTHER_STRIPE";
}

/**
 * P1-03/P1-04: creates the authoritative PaymentTransaction record from
 * Stripe's own confirmed charge data (not our own computed estimate),
 * then sends the receipt from that record. Handles both jobs and loads
 * — whichever this PaymentIntent actually belongs to.
 *
 * Idempotent on stripeChargeId (unique) — a webhook redelivery for the
 * same succeeded event finds the existing transaction and skips
 * re-creating/re-sending rather than erroring or double-emailing.
 */
async function createPaymentTransactionAndSendReceipt(paymentIntentId: string) {
  const [job, load] = await Promise.all([
    prisma.job.findUnique({ where: { stripePaymentIntentId: paymentIntentId }, include: { customer: { include: { user: true } } } }),
    prisma.carrierRoute.findUnique({ where: { stripePaymentIntentId: paymentIntentId }, include: { postedByUser: true } }),
  ]);
  if (!job && !load) return; // not a job/load PaymentIntent at all (e.g. a subscription charge)

  const intent = await stripe.paymentIntents.retrieve(paymentIntentId, {
    expand: ["latest_charge", "latest_charge.payment_method_details"],
  });
  const charge = typeof intent.latest_charge === "object" ? intent.latest_charge : null;
  if (!charge) {
    captureIntegrationAlert("payment_intent.succeeded had no expandable latest_charge — cannot generate an authoritative receipt.", {
      area: "payment", paymentIntentId,
    });
    return;
  }

  const existing = await prisma.paymentTransaction.findUnique({ where: { stripeChargeId: charge.id } });
  if (existing) return; // already processed this charge — a redelivered webhook event

  const cardDetails = charge.payment_method_details?.card;
  const transaction = await prisma.paymentTransaction.create({
    data: {
      jobId: job?.id ?? null,
      loadId: load?.id ?? null,
      stripePaymentIntentId: paymentIntentId,
      stripeChargeId: charge.id,
      amountReceivedCents: charge.amount,
      currency: charge.currency,
      paymentMethodBrand: cardDetails?.brand ?? null,
      paymentMethodLast4: cardDetails?.last4 ?? null,
      receiptUrl: charge.receipt_url ?? null,
    },
  });

  if (job) {
    const receipt = paymentReceiptTemplate({
      customerName: job.customer.user.firstName, jobTitle: job.title, totalCents: transaction.amountReceivedCents, jobId: job.id,
      paymentMethodBrand: transaction.paymentMethodBrand, paymentMethodLast4: transaction.paymentMethodLast4, stripeReceiptUrl: transaction.receiptUrl,
    });
    await queueNotification({
      userId: job.customer.userId, type: "PAYMENT_RECEIPT", channels: ["EMAIL", "IN_APP"],
      title: receipt.subject, body: receipt.text, html: receipt.html, idempotencyKey: `payment-receipt:${transaction.stripeChargeId}`,
    });
  } else if (load?.postedByUser) {
    const receipt = paymentReceiptTemplate({
      customerName: load.postedByUser.firstName, jobTitle: load.title, totalCents: transaction.amountReceivedCents, jobId: load.id, entityType: "load",
      paymentMethodBrand: transaction.paymentMethodBrand, paymentMethodLast4: transaction.paymentMethodLast4, stripeReceiptUrl: transaction.receiptUrl,
    });
    await queueNotification({
      userId: load.postedByUser.id, type: "PAYMENT_RECEIPT", channels: ["EMAIL", "IN_APP"],
      title: receipt.subject, body: receipt.text, html: receipt.html, idempotencyKey: `payment-receipt:${transaction.stripeChargeId}`,
    });
  }
}

async function processStripeEvent(event: Stripe.Event) {
  // This is the actual link-back step that was missing: nothing else ever
  // saved WorkerProfile.stripeSubscriptionId, so every later
  // customer.subscription.* event's `where: { stripeSubscriptionId: sub.id }`
  // query matched nothing.
  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    if (session.mode === "subscription" && session.subscription && session.metadata?.workerId) {
      const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription.id;
      const plan = session.metadata.plan as "MOVER" | "DRIVER_BASIC" | "OWNER_OPERATOR_PRO" | "FLEET" | undefined;
      const fleetVehicleCount = Number(session.metadata.fleetVehicleCount ?? 1);
      // Retrieve and map the subscription's REAL status — a trial-period
      // subscription genuinely starts TRIALING, not ACTIVE, and Stripe
      // doesn't guarantee webhook delivery order, so hardcoding ACTIVE
      // here could overwrite a correct TRIALING status that a
      // subscription.created event already set, or race with one still
      // in flight. This is the same mapper P1-06 introduced for the
      // subscription-lifecycle handlers — using it here too means there's
      // one authoritative mapping, not two different rules for what
      // should be the identical piece of information.
      // Always retrieve fresh, regardless of whether session.subscription
      // happened to already be an expanded object — an expanded object
      // embedded in this webhook payload is still just a snapshot taken
      // whenever Stripe serialized THIS event, which can be stale
      // relative to the subscription's actual current state. Resolving
      // the ID first and then always calling retrieve() is what fully
      // removes the webhook-ordering dependency, not just partially.
      const stripeSubscription = await stripe.subscriptions.retrieve(subscriptionId);
      const mappedStatus = mapStripeSubscriptionStatus(stripeSubscription.status);
      await prisma.workerProfile.update({
        where: { id: session.metadata.workerId },
        data: {
          stripeSubscriptionId: subscriptionId,
          ...(plan && { subscriptionPlan: plan }),
          subscriptionStatus: mappedStatus,
          subscriptionActivatedAt: new Date(),
          fleetVehicleAllowance: plan === "FLEET" ? fleetVehicleCount : 1,
        },
      });

      if (plan) {
        const worker = await prisma.workerProfile.findUnique({ where: { id: session.metadata.workerId }, select: { userId: true, displayName: true } });
        if (worker) {
          // session.amount_total is what Stripe actually charged for
          // this checkout — already reflecting fleet vehicle count,
          // any discount or promotion code applied, and tax — not a
          // hardcoded list price that silently ignored all of that.
          // Falls back to 0 only in the (rare) case Stripe hasn't
          // finalized an amount on the session yet, rather than
          // reintroducing a guessed constant.
          if (session.amount_total == null) {
            captureIntegrationAlert("Subscription checkout session had no amount_total — confirmation email will show $0.", {
              area: "billing", workerId: session.metadata.workerId, checkoutSessionId: session.id,
            });
          }
          const notice = subscriptionConfirmationTemplate({ workerName: worker.displayName ?? "there", plan, amountCents: session.amount_total ?? 0 });
          await queueNotification({
            userId: worker.userId, type: "SUBSCRIPTION_CONFIRMATION", channels: ["EMAIL", "IN_APP"],
            title: notice.subject, body: notice.text, html: notice.html, idempotencyKey: `subscription-confirmed:${subscriptionId}`,
          });
        }
      }
    }

    // Screening checkout — separate one-time payment flow from the
    // subscription branch above. Matched on metadata.type specifically so
    // a screening session and a subscription session (or any future
    // one-time payment type) can never be confused with each other, even
    // though both currently go through the same webhook handler.
    if (session.mode === "payment" && session.metadata?.type === "SCREENING_CHARGE" && session.payment_status === "paid") {
      const screeningChargeId = session.metadata.screeningChargeId;
      if (screeningChargeId) {
        const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id ?? null;

        let paymentMethodId: string | null = null;
        let paymentMethodType: string | null = null;
        let walletType: string | null = null;
        let provider: ReturnType<typeof resolveScreeningPaymentProvider> = "OTHER_STRIPE";

        if (paymentIntentId) {
          const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ["payment_method", "latest_charge"] });

          const paymentMethod = typeof paymentIntent.payment_method === "string"
            ? await stripe.paymentMethods.retrieve(paymentIntent.payment_method)
            : paymentIntent.payment_method;

          paymentMethodId = paymentMethod?.id ?? null;
          paymentMethodType = paymentMethod?.type ?? null;
          walletType = paymentMethod?.type === "card" ? paymentMethod.card?.wallet?.type ?? null : null;

          provider = resolveScreeningPaymentProvider({ paymentMethodType, walletType });
        }

        const alreadyPaid = await prisma.$transaction(async (tx) => {
          const charge = await tx.screeningCharge.findUnique({ where: { id: screeningChargeId } });
          if (!charge || charge.paidAt) return true;
          await tx.screeningCharge.update({
            where: { id: charge.id },
            data: {
              status: "PAID", paidAt: new Date(), stripePaymentIntentId: paymentIntentId,
              stripePaymentMethodId: paymentMethodId, stripePaymentMethodType: paymentMethodType,
              stripeWalletType: walletType, paymentProvider: provider,
            },
          });
          await tx.auditLog.create({
            data: {
              action: "SCREENING_PAYMENT_RECEIVED", entityType: "ScreeningCharge", entityId: charge.id,
              details: { paymentIntentId, paymentMethodId, paymentMethodType, walletType, provider },
            },
          });
          return false;
        });
        // Checkr launch happens OUTSIDE the transaction (network call) and
        // is itself idempotent (see lib/screening/start-checkr.ts) — safe
        // to call even if this webhook redelivers or alreadyPaid is true,
        // since it independently checks charge.status === "PAID" &&
        // !charge.backgroundCheck before doing anything.
        if (!alreadyPaid) {
          const { startCheckrScreening } = await import("@/lib/screening/start-checkr");
          await startCheckrScreening(screeningChargeId);
        }
      }
    }
  }

  if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.created") {
    const sub = event.data.object as Stripe.Subscription;
    const status = mapStripeSubscriptionStatus(sub.status);
    const currentEnd = new Date(sub.items.data[0].current_period_end * 1000);
    const byStripeId = await prisma.workerProfile.updateMany({
      where: { stripeSubscriptionId: sub.id },
      data: { subscriptionStatus: status, subscriptionCurrentEnd: currentEnd },
    });
    // Resilience fallback: if no WorkerProfile was matched by
    // stripeSubscriptionId (e.g. this subscription was created outside our
    // own checkout flow, or checkout.session.completed hasn't landed yet
    // due to webhook ordering), fall back to the subscription's own
    // metadata — subscription_data.metadata.workerId is set on every
    // checkout session we create, so this is a reliable second path, not a
    // guess.
    if (byStripeId.count === 0 && sub.metadata?.workerId) {
      await prisma.workerProfile.update({
        where: { id: sub.metadata.workerId },
        data: { stripeSubscriptionId: sub.id, subscriptionStatus: status, subscriptionCurrentEnd: currentEnd },
      });
    }
  }

  if (event.type === "customer.subscription.deleted") {
    const sub = event.data.object as Stripe.Subscription;
    const byStripeId = await prisma.workerProfile.updateMany({
      where: { stripeSubscriptionId: sub.id },
      data: { subscriptionStatus: "CANCELED" },
    });
    if (byStripeId.count === 0 && sub.metadata?.workerId) {
      await prisma.workerProfile.update({
        where: { id: sub.metadata.workerId },
        data: { stripeSubscriptionId: sub.id, subscriptionStatus: "CANCELED" },
      });
    }

    const worker = await prisma.workerProfile.findFirst({ where: { stripeSubscriptionId: sub.id }, select: { userId: true, displayName: true } });
    if (worker) {
      const notice = subscriptionCancellationTemplate({ workerName: worker.displayName ?? "there", endsAt: new Date(sub.items.data[0].current_period_end * 1000) });
      await queueNotification({
        userId: worker.userId, type: "SUBSCRIPTION_CANCELLATION", channels: ["EMAIL", "IN_APP"],
        title: notice.subject, body: notice.text, html: notice.html, idempotencyKey: `subscription-canceled:${sub.id}`,
      });
    }
  }

  // The subscription.updated handler above already maps "paused" via
  // mapStripeSubscriptionStatus, so this event is somewhat redundant
  // with that — but Stripe fires it as its own distinct event
  // specifically for this transition, and handling it explicitly means
  // this doesn't depend on subscription.updated always being the event
  // that carries a pause, which isn't guaranteed.
  if (event.type === "customer.subscription.paused") {
    const sub = event.data.object as Stripe.Subscription;
    await prisma.workerProfile.updateMany({
      where: { stripeSubscriptionId: sub.id },
      data: { subscriptionStatus: "PAUSED" },
    });
  }

  if (event.type === "customer.subscription.resumed") {
    const sub = event.data.object as Stripe.Subscription;
    await prisma.workerProfile.updateMany({
      where: { stripeSubscriptionId: sub.id },
      data: { subscriptionStatus: mapStripeSubscriptionStatus(sub.status) },
    });
  }

  // A subscription Checkout session that expires without completing —
  // previously nothing observed this at all, so an abandoned checkout
  // left no trace and no way to distinguish "never tried" from "started
  // and gave up."
  if (event.type === "checkout.session.expired") {
    const session = event.data.object as Stripe.Checkout.Session;
    if (session.mode === "subscription" && session.metadata?.workerId) {
      captureIntegrationAlert("A subscription Checkout session expired without completing.", {
        area: "billing", workerId: session.metadata.workerId, checkoutSessionId: session.id,
      });
    }
  }

  if (event.type === "payment_intent.succeeded") {
    const pi = event.data.object as Stripe.PaymentIntent;
    await prisma.job.updateMany({
      where: { stripePaymentIntentId: pi.id },
      data: { paymentStatus: "CAPTURED" },
    });
    await prisma.carrierRoute.updateMany({
      where: { stripePaymentIntentId: pi.id },
      data: { paymentStatus: "CAPTURED" },
    });
    await prisma.paymentAttempt.updateMany({
      where: { stripePaymentIntentId: pi.id },
      data: { paymentStatus: "CAPTURED" },
    });
    // Detention charges use a separate supplemental PaymentIntent (never
    // stored on the load's own stripePaymentIntentId) — the two updateMany
    // calls above never touch this, so it needs its own explicit update.
    if (pi.metadata?.type === "DETENTION_CHARGE") {
      await prisma.detentionCharge.updateMany({
        where: { stripePaymentIntentId: pi.id },
        data: { paymentStatus: "CAPTURED", paidAt: new Date() },
      });
    } else {
      // P1-03/P1-04: the authoritative receipt, generated here — after
      // Stripe confirms — not optimistically from the capture route,
      // which only knows what it asked for, not what was actually
      // settled (amount_received can differ, e.g. on a partial capture).
      await createPaymentTransactionAndSendReceipt(pi.id);
    }
  }

  if (event.type === "payment_intent.payment_failed") {
    const pi = event.data.object as Stripe.PaymentIntent;
    await prisma.job.updateMany({
      where: { stripePaymentIntentId: pi.id },
      data: { paymentStatus: "FAILED" },
    });
    await prisma.carrierRoute.updateMany({
      where: { stripePaymentIntentId: pi.id },
      data: { paymentStatus: "FAILED" },
    });
    await prisma.paymentAttempt.updateMany({
      where: { stripePaymentIntentId: pi.id },
      data: { paymentStatus: "FAILED", failureReason: pi.last_payment_error?.message ?? "Payment failed" },
    });
    if (pi.metadata?.type === "DETENTION_CHARGE") {
      await prisma.detentionCharge.updateMany({
        where: { stripePaymentIntentId: pi.id },
        data: { paymentStatus: "FAILED", failureReason: pi.last_payment_error?.message ?? "Payment failed" },
      });
      captureIntegrationAlert("Supplemental detention charge failed — customer action required.", {
        area: "payout", loadId: pi.metadata?.loadId, stripePaymentIntentId: pi.id,
      });
    }
  }

  // Tips — a separate, self-contained block rather than folded into the
  // generic payment_intent.succeeded/failed handlers above. Those
  // handlers are already safe for tip events (their job/load/
  // PaymentAttempt updateMany calls match on IDs a tip's PaymentIntent
  // will never have, and createPaymentTransactionAndSendReceipt already
  // no-ops when neither a Job nor a CarrierRoute matches), but handling
  // tips explicitly here is clearer than relying on that implicit
  // no-op, and avoids the wasted Stripe retrieve() call that function
  // would otherwise make before discovering it has nothing to do.
  if (event.type === "payment_intent.succeeded") {
    const pi = event.data.object as Stripe.PaymentIntent;
    if (pi.metadata?.type === "TIP") {
      const tip = await prisma.tip.findUnique({ where: { stripePaymentIntentId: pi.id } });
      // Idempotent guard, defense in depth beyond the outer
      // ProcessedStripeEvent dedup, and attemptTipAllocation's own
      // internal status check — never attempt this twice for the same
      // Tip. PAID_UNALLOCATED is excluded here deliberately: recovery
      // from that state goes through
      // POST /api/admin/tips/[tipId]/retry-allocation, not a second
      // delivery of this same webhook event.
      if (tip && tip.status !== "SUCCEEDED" && tip.status !== "PAID_UNALLOCATED") {
        const result = await attemptTipAllocation(tip.id);
        if (!result.ok) {
          captureIntegrationAlert("Tip payment succeeded but allocation could not be completed — needs manual review.", {
            area: "payment", tipId: tip.id, reason: result.reason,
          });
        } else {
          // Notifications happen AFTER the transaction commits, reading
          // back what was actually created — an external side effect
          // (sending email) has no business running inside a database
          // transaction that might still roll back.
          const entity = tip.jobId
            ? await prisma.job.findUnique({ where: { id: tip.jobId }, select: { title: true } })
            : await prisma.carrierRoute.findUnique({ where: { id: tip.loadId! }, select: { title: true } });
          const createdAllocations = await prisma.tipAllocation.findMany({ where: { id: { in: result.allocationIds } } });
          for (const allocation of createdAllocations) {
            const worker = await prisma.workerProfile.findUnique({ where: { id: allocation.workerId } });
            if (worker) {
              const notice = tipReceivedTemplate({ workerName: worker.displayName ?? "there", amountCents: allocation.amountCents, entityTitle: entity?.title ?? "your job" });
              await queueNotification({
                userId: worker.userId, type: "TIP_RECEIVED", channels: ["EMAIL", "IN_APP"],
                title: notice.subject, body: notice.text, html: notice.html, idempotencyKey: `tip-received:${allocation.id}`,
              });
            }
          }
        }
      }
    }
  }

  if (event.type === "payment_intent.payment_failed") {
    const pi = event.data.object as Stripe.PaymentIntent;
    if (pi.metadata?.type === "TIP") {
      await prisma.tip.updateMany({
        where: { stripePaymentIntentId: pi.id },
        data: { status: "FAILED", failureReason: pi.last_payment_error?.message ?? "Payment failed" },
      });
    }
  }

  if (event.type === "payment_intent.canceled") {
    const pi = event.data.object as Stripe.PaymentIntent;
    await prisma.job.updateMany({
      where: { stripePaymentIntentId: pi.id },
      data: { paymentStatus: "CANCELED" },
    });
    await prisma.carrierRoute.updateMany({
      where: { stripePaymentIntentId: pi.id },
      data: { paymentStatus: "CANCELED" },
    });
    await prisma.paymentAttempt.updateMany({
      where: { stripePaymentIntentId: pi.id },
      data: { paymentStatus: "CANCELED", canceledAt: new Date() },
    });
  }

  // Completes the P0-01 fix: the creation routes no longer assert
  // AUTHORIZED up front — this is what actually promotes a job/load to
  // AUTHORIZED, and only once Stripe itself confirms capturable funds
  // exist (e.g. after the customer completes payment-method
  // confirmation on the client), not at PaymentIntent creation time.
  if (event.type === "payment_intent.amount_capturable_updated") {
    const pi = event.data.object as Stripe.PaymentIntent;
    await prisma.$transaction([
      prisma.job.updateMany({
        where: { stripePaymentIntentId: pi.id },
        data: { paymentStatus: "AUTHORIZED" },
      }),
      prisma.carrierRoute.updateMany({
        where: { stripePaymentIntentId: pi.id },
        data: { paymentStatus: "AUTHORIZED" },
      }),
      prisma.paymentAttempt.updateMany({
        where: { stripePaymentIntentId: pi.id },
        data: { paymentStatus: "AUTHORIZED", authorizedAt: new Date() },
      }),
    ]);
  }

  // Mirrors the intent's own "processing" state (e.g. certain bank-debit
  // payment methods) — distinct from both REQUIRES_PAYMENT_METHOD (not
  // yet attempted) and AUTHORIZED (capturable funds confirmed).
  if (event.type === "payment_intent.processing") {
    const pi = event.data.object as Stripe.PaymentIntent;
    await prisma.job.updateMany({
      where: { stripePaymentIntentId: pi.id },
      data: { paymentStatus: "PROCESSING" },
    });
    await prisma.carrierRoute.updateMany({
      where: { stripePaymentIntentId: pi.id },
      data: { paymentStatus: "PROCESSING" },
    });
    await prisma.paymentAttempt.updateMany({
      where: { stripePaymentIntentId: pi.id },
      data: { paymentStatus: "PROCESSING" },
    });
  }

  // Partner invoice reconciliation — matched by our own stripeInvoiceId,
  // not partner ID from metadata, since Stripe's invoice ID is the
  // durable identifier that survives across every event for this invoice.
  if (event.type === "invoice.paid") {
    const inv = event.data.object as Stripe.Invoice;
    await prisma.partnerInvoice.updateMany({
      where: { stripeInvoiceId: inv.id },
      data: { status: "PAID", paidAt: new Date() },
    });
    // A subscription invoice being paid is what actually resolves a
    // PAST_DUE/UNPAID subscription back to current — the
    // customer.subscription.updated event alone doesn't always convey
    // this promptly.
    const subscriptionId = invoiceSubscriptionId(inv);
    if (subscriptionId) {
      await prisma.workerProfile.updateMany({
        where: { stripeSubscriptionId: subscriptionId },
        data: { subscriptionStatus: "ACTIVE" },
      });
    }
  }

  if (event.type === "invoice.payment_failed") {
    const inv = event.data.object as Stripe.Invoice;
    await prisma.partnerInvoice.updateMany({
      where: { stripeInvoiceId: inv.id },
      data: { status: "PAST_DUE" },
    });
    const subscriptionId = invoiceSubscriptionId(inv);
    if (subscriptionId) {
      await prisma.workerProfile.updateMany({
        where: { stripeSubscriptionId: subscriptionId },
        data: { subscriptionStatus: "PAST_DUE" },
      });
    }
    captureIntegrationAlert("Partner invoice payment failed.", { area: "billing", stripeInvoiceId: inv.id });
  }

  if (event.type === "invoice.voided") {
    const inv = event.data.object as Stripe.Invoice;
    await prisma.partnerInvoice.updateMany({
      where: { stripeInvoiceId: inv.id },
      data: { status: "VOID", voidedAt: new Date() },
    });
  }

  if (event.type === "charge.refunded") {
    const charge = event.data.object as Stripe.Charge;
    const paymentIntentId = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
    if (paymentIntentId) {
      const refundStatus = charge.refunded ? "REFUNDED" : "PARTIALLY_REFUNDED";
      const job = await prisma.job.findFirst({ where: { stripePaymentIntentId: paymentIntentId } });
      const route = await prisma.carrierRoute.findFirst({ where: { stripePaymentIntentId: paymentIntentId } });
      await prisma.job.updateMany({
        where: { stripePaymentIntentId: paymentIntentId },
        data: { paymentStatus: refundStatus },
      });
      await prisma.carrierRoute.updateMany({
        where: { stripePaymentIntentId: paymentIntentId },
        data: { paymentStatus: refundStatus },
      });
      // PaymentTransaction is the single source of truth receipts are
      // generated from — a refund that never updates it here means any
      // future or already-sent receipt silently disagrees with reality.
      // This field is deliberately cumulative (matching Stripe's own
      // charge.amount_refunded) — per-refund detail lives on the
      // individual PaymentRefund rows, reconciled below in
      // refund.updated, not here.
      await prisma.paymentTransaction.updateMany({
        where: { stripeChargeId: charge.id },
        data: { refundedAmountCents: charge.amount_refunded },
      });

      // Customer notification intentionally does NOT happen here — see
      // refund.updated below, which sends it using the SPECIFIC refund's
      // own amount rather than charge.amount_refunded (cumulative,
      // flagged by a V27 audit as producing a misleading notice on a
      // second partial refund: it would describe the running total, not
      // what that specific refund was for).

      // Bonus recovery is scoped to FULL refunds only — deliberately more
      // conservative than reversing an entire bonus on any partial
      // refund, which a V27 audit flagged as an unconfirmed business
      // rule. A partial refund alerts for manual review instead of
      // silently reversing something that may not be warranted.
      if (charge.refunded) {
        if (job) {
          await recoverBonusesForQualifyingEntity({
            qualifyingEntityId: job.id,
            reason: `Full refund on job ${job.id} (${event.id})`,
            stripeEventId: event.id,
            relatedJobId: job.id,
          });
        }
        if (route) {
          await recoverBonusesForQualifyingEntity({
            qualifyingEntityId: route.id,
            reason: `Full refund on load ${route.id} (${event.id})`,
            stripeEventId: event.id,
            relatedRouteId: route.id,
          });
        }
      } else if (job || route) {
        captureIntegrationAlert("Partial refund issued — bonus-recovery policy for partial refunds is not yet confirmed, so no automatic recovery was applied. Review manually.", {
          area: "payment", jobId: job?.id, loadId: route?.id, stripeChargeId: charge.id, amountRefundedCents: charge.amount_refunded,
        });
      }
    }
  }

  // P1-05: reconciles the INDIVIDUAL PaymentRefund row this specific
  // Stripe refund corresponds to — matched by stripeRefundId, set when
  // the refund route (app/api/admin/payment-transactions/[id]/refund)
  // submitted it. This is what makes the customer notice accurate for a
  // second (or later) partial refund: each notice is built from THIS
  // refund's own amountCents, never the cumulative charge total.
  if (event.type === "refund.updated" || event.type === "refund.created") {
    const stripeRefundObj = event.data.object as Stripe.Refund;
    const paymentRefund = await prisma.paymentRefund.findUnique({
      where: { stripeRefundId: stripeRefundObj.id },
      include: {
        paymentTransaction: {
          include: {
            job: { include: { customer: { include: { user: true } } } },
            load: { include: { postedByUser: true } },
          },
        },
      },
    });
    if (!paymentRefund) {
      // Not necessarily an error — could be a refund created outside
      // this API (e.g. directly in the Stripe dashboard). Flagged per
      // the audit's explicit requirement, not silently ignored.
      captureIntegrationAlert("Refund webhook event did not match a known PaymentRefund — possibly issued outside the admin refund API.", {
        area: "payment", stripeRefundId: stripeRefundObj.id, eventType: event.type,
      });
    } else {
      const status = stripeRefundObj.status === "succeeded" ? "SUCCEEDED" : stripeRefundObj.status === "failed" ? "FAILED" : stripeRefundObj.status === "canceled" ? "CANCELED" : "PENDING";
      const statusChanged = status !== paymentRefund.status;

      if (statusChanged) {
        await prisma.paymentRefund.update({
          where: { id: paymentRefund.id },
          data: {
            status,
            failureCode: stripeRefundObj.failure_reason ?? null,
            succeededAt: status === "SUCCEEDED" ? new Date() : paymentRefund.succeededAt,
            failedAt: status === "FAILED" ? new Date() : paymentRefund.failedAt,
          },
        });
        await prisma.auditLog.create({
          data: {
            actorId: paymentRefund.requestedByUserId,
            action: status === "SUCCEEDED" ? "REFUND_SUCCEEDED" : status === "FAILED" ? "REFUND_FAILED" : "REFUND_REQUESTED",
            entityType: "PaymentRefund", entityId: paymentRefund.id,
            details: { stripeRefundId: stripeRefundObj.id, status, amountCents: paymentRefund.amountCents, reason: paymentRefund.reason, result: status },
          },
        });
      }

      // Deliberately NOT gated on statusChanged: a refund that succeeds
      // synchronously in Stripe's own API response (the common case for
      // card refunds) already has status SUCCEEDED set by the refund
      // route itself, before this webhook event ever arrives — gating
      // on "did the status change here" would mean the notification
      // below never fires at all for that common case, since this
      // handler would see no change. queueNotification's own
      // idempotency-key dedup (confirmed in lib/notifications) is what
      // safely prevents an actual duplicate send if this does run more
      // than once for the same refund.
      if (status === "SUCCEEDED") {
        const tx = paymentRefund.paymentTransaction;
        const job = tx.job;
        const load = tx.load;
        const fullyRefunded = tx.refundedAmountCents + paymentRefund.amountCents >= tx.amountReceivedCents;
        if (job) {
          const notice = refundNoticeTemplate({ customerName: job.customer.user.firstName, jobTitle: job.title, refundedAmountCents: paymentRefund.amountCents, fullyRefunded });
          await queueNotification({
            userId: job.customer.userId, type: "REFUND_NOTICE", channels: ["EMAIL", "IN_APP"],
            title: notice.subject, body: notice.text, html: notice.html, idempotencyKey: `refund-notice:${paymentRefund.id}`,
          });
        } else if (load?.postedByUser) {
          const notice = refundNoticeTemplate({ customerName: load.postedByUser.firstName, jobTitle: load.title, refundedAmountCents: paymentRefund.amountCents, fullyRefunded });
          await queueNotification({
            userId: load.postedByUser.id, type: "REFUND_NOTICE", channels: ["EMAIL", "IN_APP"],
            title: notice.subject, body: notice.text, html: notice.html, idempotencyKey: `refund-notice:${paymentRefund.id}`,
          });
        }
      } else if (status === "FAILED" && statusChanged) {
        captureIntegrationAlert("A PaymentRefund reached FAILED status via webhook.", {
          area: "payment", paymentRefundId: paymentRefund.id, failureCode: stripeRefundObj.failure_reason ?? null,
        });
      }
    }
  }

  if (event.type === "charge.dispute.created") {
    const dispute = event.data.object as Stripe.Dispute;
    const paymentIntentId = typeof dispute.payment_intent === "string" ? dispute.payment_intent : dispute.payment_intent?.id;
    if (paymentIntentId) {
      const screeningCharge = await prisma.screeningCharge.findFirst({ where: { stripePaymentIntentId: paymentIntentId } });
      if (screeningCharge) {
        // Restrict new opportunity actions immediately on dispute open, not
        // just once lost — per the handoff, and matching checkOpportunityAccess's
        // read of WorkerCompliance.adminApprovalStatus. Screening records
        // themselves are preserved, not deleted or exposed differently.
        await prisma.screeningCharge.update({ where: { id: screeningCharge.id }, data: { status: "DISPUTED" } });
        await prisma.workerCompliance.upsert({
          where: { workerId: screeningCharge.workerId },
          update: { adminApprovalStatus: "RESTRICTED", restrictedAt: new Date(), restrictionReason: `Screening payment disputed (${event.id})` },
          create: { workerId: screeningCharge.workerId, adminApprovalStatus: "RESTRICTED", restrictedAt: new Date(), restrictionReason: `Screening payment disputed (${event.id})` },
        });
        await prisma.auditLog.create({
          data: { action: "SCREENING_DISPUTED", entityType: "ScreeningCharge", entityId: screeningCharge.id, details: { stripeDisputeId: dispute.id } },
        });
      }
    }
  }

  if (event.type === "charge.dispute.closed") {
    const dispute = event.data.object as Stripe.Dispute;
    if (dispute.status === "lost") {
      const paymentIntentId = typeof dispute.payment_intent === "string" ? dispute.payment_intent : dispute.payment_intent?.id;
      if (paymentIntentId) {
        const job = await prisma.job.findFirst({ where: { stripePaymentIntentId: paymentIntentId } });
        const route = await prisma.carrierRoute.findFirst({ where: { stripePaymentIntentId: paymentIntentId } });
        await prisma.job.updateMany({
          where: { stripePaymentIntentId: paymentIntentId },
          data: { paymentStatus: "DISPUTED" },
        });
        if (job) {
          await recoverBonusesForQualifyingEntity({
            qualifyingEntityId: job.id,
            reason: `Chargeback lost on job ${job.id} (${event.id})`,
            stripeEventId: event.id,
            relatedJobId: job.id,
          });
        }
        if (route) {
          await recoverBonusesForQualifyingEntity({
            qualifyingEntityId: route.id,
            reason: `Chargeback lost on load ${route.id} (${event.id})`,
            stripeEventId: event.id,
            relatedRouteId: route.id,
          });
        }
      }
    }
  }

  if (event.type === "account.updated") {
    const account = event.data.object as Stripe.Account;
    await prisma.workerProfile.updateMany({
      where: { stripeAccountId: account.id },
      data: {
        stripeChargesEnabled: !!account.charges_enabled,
        stripePayoutsEnabled: !!account.payouts_enabled,
        stripeConnectOnboarded: !!account.details_submitted,
      },
    });
  }

  if (event.type === "transfer.created") {
    // TRANSFERRED, not PAID_OUT — confirms movement to the connected
    // account balance, not confirmed arrival in the worker's bank. See
    // app/api/payouts/[payoutId]/pay/route.ts for the same reasoning.
    const transfer = event.data.object as Stripe.Transfer;
    await prisma.payout.updateMany({
      where: { stripeTransferId: transfer.id },
      data: { status: "TRANSFERRED", paidAt: new Date() },
    });
    await prisma.settlement.updateMany({
      where: { stripeTransferId: transfer.id },
      data: { status: "TRANSFERRED", paidAt: new Date() },
    });
  }

  if (event.type === "transfer.reversed") {
    const transfer = event.data.object as Stripe.Transfer;
    const reason = "Transfer reversed by Stripe.";
    await prisma.payout.updateMany({
      where: { stripeTransferId: transfer.id },
      data: { status: "REVERSED", reversedAt: new Date(), failureReason: reason },
    });
    await prisma.settlement.updateMany({
      where: { stripeTransferId: transfer.id },
      data: { status: "REVERSED", reversedAt: new Date(), failureReason: reason },
    });
  }

  // P1-08's remaining gap: PAID_OUT existed as a status value everywhere
  // it was CHECKED (e.g. "already paid" guards in the pay routes), but
  // nothing anywhere ever actually WROTE it — the lifecycle had no path
  // to its own true terminal state. TRANSFERRED only confirms money
  // reached the worker's Stripe CONNECT BALANCE, not their bank account;
  // payout.paid is Stripe's own confirmation of the second hop.
  //
  // Important limitation, stated plainly rather than glossed over: a
  // Stripe "Payout" object represents a SWEEP of a connected account's
  // entire available balance to their bank on Stripe's own schedule —
  // it has no direct reference back to which specific Transfer(s)
  // contributed to that balance. There is no precise, official way to
  // say "this payout.paid event corresponds to exactly this Payout/
  // Settlement row." This advances every currently-TRANSFERRED row for
  // the connected account to PAID_OUT as a reasonable approximation
  // (Stripe's default behavior sweeps the full balance), which can be
  // wrong in edge cases — a worker with a rolling reserve, an unusual
  // manual payout schedule, or partial balance holds could have some
  // TRANSFERRED funds marked PAID_OUT before they've actually reached
  // that specific bank deposit. Flagged here, not hidden: exact
  // reconciliation would require tracing the connected account's
  // balance transaction history, which is a materially larger feature
  // than this pass's scope.
  if (event.type === "payout.paid" && event.account) {
    const payoutObj = event.data.object as Stripe.Payout;
    const worker = await prisma.workerProfile.findUnique({ where: { stripeAccountId: event.account } });
    if (worker) {
      // Fetch the affected rows FIRST so each can get its own accurate
      // notification (a worker can have multiple Payout/Settlement rows
      // advance in the same sweep, each a genuinely distinct amount) —
      // updateMany alone wouldn't return enough detail to notify from.
      const affectedPayouts = await prisma.payout.findMany({ where: { workerId: worker.id, status: "TRANSFERRED" } });
      const affectedSettlements = await prisma.settlement.findMany({ where: { workerId: worker.id, status: "TRANSFERRED" } });

      await prisma.payout.updateMany({
        where: { workerId: worker.id, status: "TRANSFERRED" },
        data: { status: "PAID_OUT", paidOutAt: new Date(), stripePayoutId: payoutObj.id },
      });
      await prisma.settlement.updateMany({
        where: { workerId: worker.id, status: "TRANSFERRED" },
        data: { status: "PAID_OUT", paidOutAt: new Date(), stripePayoutId: payoutObj.id },
      });

      for (const p of affectedPayouts) {
        const notice = payoutStatusTemplate({ workerName: worker.displayName ?? "there", status: "PAID_OUT", netPayoutCents: p.netPayoutCents });
        await queueNotification({
          userId: worker.userId, type: "PAYOUT_STATUS", channels: ["EMAIL", "IN_APP"],
          title: notice.subject, body: notice.text, html: notice.html, idempotencyKey: `payout-paidout:${p.id}:${payoutObj.id}`,
        });
      }
      for (const s of affectedSettlements) {
        const notice = payoutStatusTemplate({ workerName: worker.displayName ?? "there", status: "PAID_OUT", netPayoutCents: s.netCents });
        await queueNotification({
          userId: worker.userId, type: "PAYOUT_STATUS", channels: ["EMAIL", "IN_APP"],
          title: notice.subject, body: notice.text, html: notice.html, idempotencyKey: `settlement-paidout:${s.id}:${payoutObj.id}`,
        });
      }
    } else {
      captureIntegrationAlert("payout.paid event for a connected account with no matching WorkerProfile.", {
        area: "payout", stripeAccountId: event.account,
      });
    }
  }

  if (event.type === "payout.failed" && event.account) {
    const payoutObj = event.data.object as Stripe.Payout;
    // Does NOT revert TRANSFERRED — the original Transfer to the
    // connected account's balance already succeeded regardless of
    // whether Stripe's own downstream bank payout failed. Reverting to
    // some other status here would incorrectly imply the original
    // transfer itself failed, when it's Stripe's separate payout step
    // that did. This needs a human to look at Stripe's dashboard for
    // that connected account, not an automatic status change.
    captureIntegrationAlert("Stripe payout to a connected account's bank failed — the underlying Transfer(s) are unaffected, but this needs manual review.", {
      area: "payout", stripeAccountId: event.account, stripePayoutId: payoutObj.id, failureCode: payoutObj.failure_code ?? null, failureMessage: payoutObj.failure_message ?? null,
    });
  }
}

export async function POST(request: Request) {
  const signature = request.headers.get("stripe-signature");
  if (!signature || !process.env.STRIPE_WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Missing webhook configuration." }, { status: 400 });
  }

  const body = await request.text();
  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET,
    );
  } catch {
    return NextResponse.json({ error: "Invalid signature." }, { status: 400 });
  }

  // Replay protection, done right: COMPLETED is only written AFTER business
  // logic succeeds, not before. The old version recorded the event as
  // handled up front — a failure partway through (e.g. the DB write for a
  // refund) would silently and permanently lose that update, because
  // Stripe's retry would see the row already exists and bail out thinking
  // it was a harmless duplicate. Now a retry after a genuine failure
  // actually reprocesses instead of being swallowed.
  const existing = await prisma.processedStripeEvent.findUnique({ where: { id: event.id } });
  if (existing?.status === "COMPLETED") {
    return NextResponse.json({ received: true, duplicate: true });
  }

  await prisma.processedStripeEvent.upsert({
    where: { id: event.id },
    create: { id: event.id, type: event.type, status: "PROCESSING" },
    update: { status: "PROCESSING", attemptCount: { increment: 1 }, lastError: null },
  });

  try {
    await processStripeEvent(event);
    await prisma.processedStripeEvent.update({
      where: { id: event.id },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
  } catch (error) {
    await prisma.processedStripeEvent.update({
      where: { id: event.id },
      data: { status: "FAILED", lastError: error instanceof Error ? error.message : "Unknown processing error" },
    });
    // Rethrow so this returns a non-2xx status — that's what tells Stripe
    // to actually retry delivery instead of considering the event handled.
    throw error;
  }

  return NextResponse.json({ received: true });
}
