// Worker payment states — VASRUE Digital Media, 29 October 2026.
// The labels a worker sees for their pay (payment spec §7): never "paid to
// bank" for a transfer that has only reached their Stripe account.

export type PayStatus = "ESTIMATED" | "EARNED_PENDING_REVIEW" | "APPROVED_AWAITING_TRANSFER" | "HELD" | "TRANSFER_IN_PROGRESS" | "TRANSFERRED_BANK_PAYOUT_PENDING" | "PAID_TO_BANK" | "FAILED";

export const PAY_STATUS_LABELS: Record<PayStatus, string> = {
  ESTIMATED: "Estimated",
  EARNED_PENDING_REVIEW: "Earned, pending review",
  APPROVED_AWAITING_TRANSFER: "Approved, awaiting transfer",
  HELD: "Held for review",
  TRANSFER_IN_PROGRESS: "Transfer in progress",
  TRANSFERRED_BANK_PAYOUT_PENDING: "Sent to your Stripe account, bank payout pending",
  PAID_TO_BANK: "Paid to your bank",
  FAILED: "Transfer failed, will be retried",
};

export function payStatus(payout: { status: string } | null): PayStatus {
  if (!payout) return "ESTIMATED";
  switch (payout.status) {
    case "PENDING": return "EARNED_PENDING_REVIEW";
    case "SCHEDULED": return "APPROVED_AWAITING_TRANSFER";
    case "HELD": return "HELD";
    case "PROCESSING": return "TRANSFER_IN_PROGRESS";
    case "TRANSFERRED": return "TRANSFERRED_BANK_PAYOUT_PENDING";
    case "PAID_OUT": return "PAID_TO_BANK";
    case "FAILED": return "FAILED";
    default: return "EARNED_PENDING_REVIEW";
  }
}
