import { baseLayout, button, APP_URL } from "./base";

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

export function paymentReceiptTemplate({
  customerName, jobTitle, totalCents, jobId, entityType = "job", paymentMethodBrand, paymentMethodLast4, stripeReceiptUrl,
}: {
  customerName: string; jobTitle: string; totalCents: number; jobId: string; entityType?: "job" | "load";
  paymentMethodBrand?: string | null; paymentMethodLast4?: string | null; stripeReceiptUrl?: string | null;
}) {
  const url = `${APP_URL}/customer/${entityType === "load" ? "loads" : "jobs"}/${jobId}`;
  const cardLine = paymentMethodBrand && paymentMethodLast4
    ? `<p style="color:#637089;font-size:13px;">Charged to ${paymentMethodBrand} ending in ${paymentMethodLast4}.</p>` : "";
  const stripeReceiptLine = stripeReceiptUrl ? `<p style="margin-top:10px;"><a href="${stripeReceiptUrl}">View Stripe receipt</a></p>` : "";
  return {
    subject: `Receipt for ${jobTitle}`,
    html: baseLayout(`<h1 style="font-size:18px;">Payment receipt</h1><p>Hi ${customerName},</p><p>You were charged <strong>${money(totalCents)}</strong> for <strong>${jobTitle}</strong>.</p>${cardLine}${button(url, "View receipt")}${stripeReceiptLine}`),
    text: `Receipt: ${money(totalCents)} for ${jobTitle}.${paymentMethodBrand && paymentMethodLast4 ? ` Charged to ${paymentMethodBrand} ending in ${paymentMethodLast4}.` : ""} ${url}`,
  };
}

export function refundNoticeTemplate({
  customerName, jobTitle, refundedAmountCents, fullyRefunded,
}: { customerName: string; jobTitle: string; refundedAmountCents: number; fullyRefunded: boolean }) {
  return {
    subject: fullyRefunded ? `Refund issued for ${jobTitle}` : `Partial refund issued for ${jobTitle}`,
    html: baseLayout(`<h1 style="font-size:18px;">${fullyRefunded ? "Refund issued" : "Partial refund issued"}</h1><p>Hi ${customerName},</p><p>A refund of <strong>${money(refundedAmountCents)}</strong> has been issued for <strong>${jobTitle}</strong>.</p>`),
    text: `${fullyRefunded ? "Refund" : "Partial refund"} of ${money(refundedAmountCents)} issued for ${jobTitle}.`,
  };
}

export function subscriptionConfirmationTemplate({ workerName, plan, amountCents }: { workerName: string; plan: string; amountCents: number }) {
  return {
    subject: "Your TempMovers subscription is active",
    html: baseLayout(`<h1 style="font-size:18px;">Subscription confirmed</h1><p>Hi ${workerName},</p><p>Your <strong>${plan.replaceAll("_", " ")}</strong> plan is now active. You were charged <strong>${money(amountCents)}</strong> today.</p>`),
    text: `Your ${plan.replaceAll("_", " ")} subscription is now active. You were charged ${money(amountCents)} today.`,
  };
}

export function subscriptionRenewalFailureTemplate({ workerName, updatePaymentUrl }: { workerName: string; updatePaymentUrl: string }) {
  return {
    subject: "Action needed: subscription payment failed",
    html: baseLayout(`<h1 style="font-size:18px;">Your subscription payment failed</h1><p>Hi ${workerName},</p><p>We couldn't process your subscription renewal. Update your payment method to keep accepting jobs.</p>${button(updatePaymentUrl, "Update payment method")}`),
    text: `Your TempMovers subscription payment failed. Update it here: ${updatePaymentUrl}`,
  };
}

export function subscriptionCancellationTemplate({ workerName, endsAt }: { workerName: string; endsAt: Date }) {
  return {
    subject: "Your subscription has been canceled",
    html: baseLayout(`<h1 style="font-size:18px;">Subscription canceled</h1><p>Hi ${workerName},</p><p>Your subscription is canceled and will end on ${endsAt.toLocaleDateString()}. You'll need an active plan to keep accepting jobs after that date.</p>`),
    text: `Your subscription is canceled, ending ${endsAt.toLocaleDateString()}.`,
  };
}

export function tipReceivedTemplate({ workerName, amountCents, entityTitle }: { workerName: string; amountCents: number; entityTitle: string }) {
  return {
    subject: `TempMovers: You received a ${money(amountCents)} tip!`,
    html: baseLayout(`<h1 style="font-size:18px;">You got a tip!</h1><p>Hi ${workerName},</p><p>A customer left a <strong>${money(amountCents)}</strong> tip for "${entityTitle}" — 100% goes to you, no platform fee.</p>`),
    text: `You received a ${money(amountCents)} tip for "${entityTitle}" — 100% goes to you, no platform fee.`,
  };
}

export function payoutStatusTemplate({ workerName, status, netPayoutCents }: { workerName: string; status: "SCHEDULED" | "TRANSFERRED" | "PAID_OUT" | "FAILED" | "OFFSET"; netPayoutCents: number }) {
  const copy: Record<typeof status, { subject: string; line: string }> = {
    SCHEDULED: { subject: "Payout initiated", line: `A payout of ${money(netPayoutCents)} has been initiated.` },
    TRANSFERRED: { subject: "Funds transferred", line: `${money(netPayoutCents)} has been transferred to your Stripe payout balance. Bank arrival depends on Stripe's payout schedule.` },
    PAID_OUT: { subject: "Payout deposited", line: `${money(netPayoutCents)} has been deposited to your bank account.` },
    FAILED: { subject: "Payout failed", line: "A payout attempt failed. Our team has been notified and will retry." },
    OFFSET: { subject: "Payout fully offset", line: "A scheduled payout was fully offset by an outstanding balance — nothing was transferred this time." },
  };
  const { subject, line } = copy[status];
  return {
    subject: `TempMovers: ${subject}`,
    html: baseLayout(`<h1 style="font-size:18px;">${subject}</h1><p>Hi ${workerName},</p><p>${line}</p>`),
    text: `${subject}: ${line}`,
  };
}
