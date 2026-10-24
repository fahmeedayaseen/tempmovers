/**
 * Payment exception queue classification (launch spec §6). PURE. Decides which
 * factoring/payment-routing situations are unresolved exceptions that must be
 * cleared before automated payout can run.
 *
 * The hard rule: NO unresolved payment-routing exception may reach automated
 * payout. The payout service calls hasBlockingPaymentException() and must halt
 * that carrier's payout if it returns true.
 */
export type PaymentExceptionInput = {
  pendingNoaReview: boolean;         // a NOA awaiting verification
  replacementNoaPending: boolean;    // a replacement NOA not yet reviewed
  letterOfReleasePending: boolean;
  conflictingInstructions: boolean;  // >1 active-ish remittance target
  expiredAssignment: boolean;        // an assignment whose NOA/doc lapsed
  routingChangeRequested: boolean;   // a carrier change-request awaiting review
  blockedDirectPaymentAttempt: boolean;
  missingSupportingDocument: boolean;
};

export type PaymentException = { code: string; message: string };

const RULES: { key: keyof PaymentExceptionInput; code: string; message: string }[] = [
  { key: "pendingNoaReview", code: "NOA_PENDING_REVIEW", message: "A Notice of Assignment is awaiting verification." },
  { key: "replacementNoaPending", code: "REPLACEMENT_NOA_PENDING", message: "A replacement Notice of Assignment needs review." },
  { key: "letterOfReleasePending", code: "LETTER_OF_RELEASE_PENDING", message: "A Letter of Release needs review." },
  { key: "conflictingInstructions", code: "CONFLICTING_PAYMENT_INSTRUCTIONS", message: "Conflicting payment instructions are present." },
  { key: "expiredAssignment", code: "EXPIRED_PAYMENT_ASSIGNMENT", message: "A payment assignment has expired and needs a valid destination." },
  { key: "routingChangeRequested", code: "ROUTING_CHANGE_REQUESTED", message: "A routing-change request is awaiting administrative review." },
  { key: "blockedDirectPaymentAttempt", code: "BLOCKED_DIRECT_PAYMENT_ATTEMPT", message: "A blocked direct-payment attempt needs review." },
  { key: "missingSupportingDocument", code: "MISSING_SUPPORTING_DOCUMENT", message: "Supporting documentation is missing for a routing change." },
];

export function classifyPaymentExceptions(input: PaymentExceptionInput): PaymentException[] {
  return RULES.filter((r) => input[r.key]).map((r) => ({ code: r.code, message: r.message }));
}

/** The payout gate: true if any unresolved exception exists (halt payout). */
export function hasBlockingPaymentException(input: PaymentExceptionInput): boolean {
  return classifyPaymentExceptions(input).length > 0;
}
