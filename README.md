# TempMovers.com Full-Stack Starter

A production-oriented Next.js, Prisma, PostgreSQL, and Stripe starter for a nationwide hourly moving-labor and commercial-driver marketplace.

## Included portals

- Public marketplace
- Customer dashboard
- Mover dashboard
- Box-truck and semi-driver portal
- Admin operations dashboard

## Fixed commercial rules

- TempMovers earns **$5 per approved hour, per mover**
- Each mover pays **$19.95 per month**
- Every moving project has a **three-hour minimum**
- Every moving project requires **at least two movers**
- Same-day/urgent projects can receive a configurable premium
- Mover tips should pass through 100%

## Payments — Stripe setup

The full authorize → capture → payout flow is wired end-to-end in code. To go
live, you're filling in Dashboard configuration and environment variables —
not writing payment logic.

**What's implemented:**
- Job/load booking creates a manual-capture PaymentIntent (`POST
  /api/stripe/job-payment-intent`, `/api/stripe/driver-payment-intent`) and
  saves the intent ID onto the job/load record
- `POST /api/jobs/[jobId]/capture-payment` and `POST
  /api/loads/[loadId]/capture-payment` (admin-only) capture the hold once
  work is completed and approved — nothing captures automatically or early
- `POST /api/payouts/[payoutId]/pay` (admin-only) creates the real Stripe
  Transfer to a worker's Connect Express account
- `POST /api/stripe/worker-subscription` creates Stripe Checkout subscription
  sessions for all worker plans (mover, driver basic, owner-operator pro,
  fleet), including the first-job waiver check, fleet extra-vehicle line
  items, and auto-creating the worker's own Stripe Customer for billing
- `POST /api/stripe/connect-onboarding` creates (or reuses) a worker's Connect
  Express account and persists the account ID
- `POST /api/stripe/webhook` reconciles subscription status, payment capture,
  failures, refunds, lost chargebacks, Connect account status, and transfers —
  and is idempotent: every event ID is recorded in `ProcessedStripeEvent`
  before processing, so Stripe's normal webhook redelivery can't double-apply
  a state change
- Every PaymentIntent/Transfer/Account creation call carries a stable
  idempotency key, so a retried request can't create a duplicate charge,
  payout, or Connect account

**What you still need to do in the Stripe Dashboard (test mode first):**
1. Create Prices for each subscription tier (mover membership, driver basic,
   owner-operator pro, fleet, fleet extra vehicle) and put their IDs in
   `.env.local` (`STRIPE_MOVER_SUBSCRIPTION_PRICE_ID`, etc. — see
   `.env.example` for the full list).
2. Enable Connect (Express) on your Stripe account.
3. Add a webhook endpoint pointing at `/api/stripe/webhook` and subscribe it
   to: `payment_intent.succeeded`, `payment_intent.payment_failed`,
   `payment_intent.canceled`, `charge.refunded`, `charge.dispute.closed`,
   `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `account.updated`, `transfer.created`,
   `transfer.reversed`. Copy the signing secret into
   `STRIPE_WEBHOOK_SECRET`.
4. Put your test secret/publishable keys into `STRIPE_SECRET_KEY` and
   `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`.

**Testing locally with the Stripe CLI:**
```bash
stripe login
stripe listen --forward-to localhost:3000/api/stripe/webhook
# in another terminal, once you have a real PaymentIntent/subscription/transfer:
stripe trigger payment_intent.succeeded
stripe trigger charge.refunded
stripe trigger customer.subscription.updated
```
`stripe listen` prints a webhook signing secret — use that value for
`STRIPE_WEBHOOK_SECRET` during local testing (it differs from your Dashboard
endpoint's secret).

Platform fees are calculated in `lib/pricing.ts` and stored per job/load —
never trusted from the client — and mover/driver payouts are never reduced by
the platform fee, matching the pricing rules below.

The current package does not contain live Stripe credentials, real Price IDs,
or a production webhook signing secret — those are yours to create.

## Payment system audit — P0-01, P0-02, P0-03 done; P0-04/P0-05 not started

A large payment-system audit (5 critical, 8 high, 4 medium findings)
covering authorization state, final capture amounts, billing portal,
partner billing, and freight settlements.

### P0-01 — payment status recorded before authorization existed

**Files:** `lib/stripe.ts`, `app/api/stripe/job-payment-intent/route.ts`,
`app/api/stripe/driver-payment-intent/route.ts`,
`app/api/stripe/webhook/route.ts`

Both creation routes asserted `paymentStatus: "AUTHORIZED"` immediately
after creating a PaymentIntent, before Stripe had confirmed anything —
a manual-capture PaymentIntent typically still requires payment-method
confirmation at that point, so an unpaid booking could show as funded.
Both routes now derive status from the intent's real state via
`mapStripeIntentStatus()` (reused from earlier detention-charge work,
not duplicated). Added a `payment_intent.amount_capturable_updated`
webhook handler — this is what actually promotes a job/load to
`AUTHORIZED`, only once Stripe confirms capturable funds — plus a
`payment_intent.processing` handler.

**Schema:** `PaymentStatus` gained `PROCESSING` and `CANCELED` as
distinct values. Previously a canceled intent was recorded as `FAILED`,
conflating two different situations — an intent that expired/was
voided vs. one where a charge attempt genuinely failed.

**Env vars:** none new.

### P0-02 — capture used the estimate, not final approved hours

**Files:** `app/api/jobs/[jobId]/capture-payment/route.ts`,
`app/api/assignments/[assignmentId]/approve/route.ts`, `lib/pricing.ts`
(constant reused, not modified), `prisma/schema.prisma`

The route called `stripe.paymentIntents.capture(id, {})` with an empty
body — captures the entire authorization regardless of what actually
happened. Now computes a real final total per assignment and captures
that specific amount.

**A second, more serious bug found while implementing this, not in the
original audit**: my first pass computed final labor by re-prorating
`agreedEarningsCents` against `scheduledHours`/`actualHours` — but
tracing where `agreedEarningsCents` is actually set
(`agreedEarningsCents: job.customerMoverRateCents` at assignment
creation) showed it's a **per-hour rate**, not a fixed total. The
separate assignment-approval route (which creates the worker's own
`Payout`) already correctly used `rate × hours` with a 3-hour floor —
my capture formula used a completely different, incorrect
interpretation of the same field. Fixed both routes to use the
identical formula (`agreedEarningsCents × max(3, actualHours)`, using
the shared `MINIMUM_JOB_HOURS` constant from `lib/pricing.ts` instead
of each route hardcoding `3` separately) — the customer charge and the
worker payout must be derived from the same per-assignment basis or the
platform's own revenue silently drifts from what it's supposed to be.

**A third bug found in the same pass**: nothing in this codebase ever
actually set `Job.status` to `COMPLETED` — capture's own precondition
could never have been satisfied by any real code path. Added that
transition to the assignment-approval route: when the last outstanding
`CHECKED_OUT` assignment for a job is approved, the job moves to
`COMPLETED` (checked fresh against the database at approval time, not
assumed from the current request, so a job requiring multiple movers
correctly waits for all of them).

**The six specific confirmations requested, verified against the actual
code rather than asserted:**
- *Only completed, billable assignments are included in the final wage
  calculation* — `billableAssignments` is scoped to `CHECKED_OUT`/
  `APPROVED` only, and every one must reach `APPROVED` before capture
  proceeds.
- *Declined, canceled, replaced, or no-show workers receive no
  payout* — confirmed by grep that `prisma.payout.create` exists in
  exactly one place in the entire codebase, hard-gated on
  `assignment.status === "CHECKED_OUT"`, which `DECLINED`/`CANCELED`/
  `NO_SHOW` can never reach. Structurally guaranteed, not just assumed.
- *The final customer charge is recalculated from approved actual hours
  and approved billable items* — yes, per the formula fix above.
- *Capture cannot occur while a completed assignment is still awaiting
  customer approval* — any assignment at `CHECKED_OUT` (checked out,
  not yet approved) fails the pre-capture validation and blocks with a
  409.
- *Calculation and approval records are preserved for audit/dispute* —
  `pricingSnapshot` (Json) persists the exact per-assignment numbers
  that produced the final total; `finalLaborCents`/
  `finalPlatformFeeCents`/`finalTotalCents`/`authorizedAmountCents`/
  `capturedAmountCents`/`capturedAt` are all persisted independently of
  the original estimate, which is kept too, not overwritten.
- *Idempotent — cannot be captured twice* — hardened beyond the
  original read-then-write check (a real TOCTOU race between two
  concurrent requests), to an atomic `updateMany` that claims the
  capture (via `capturedAt`) before ever calling Stripe. Only the
  request that actually wins the claim proceeds; the claim is released
  if the Stripe call itself throws, so a genuine retry after a
  transient failure isn't permanently locked out.

**Schema additions:** `Job.finalLaborCents`, `finalPlatformFeeCents`,
`finalTotalCents`, `authorizedAmountCents`, `capturedAmountCents`,
`pricingSnapshot Json?`, `capturedAt DateTime?`.

**Test results:** none — no test runner has network access to install
in this environment, consistent with every prior round in this project.
Verified by direct code inspection, schema/field tracing, and grep-based
exhaustiveness checks (e.g., confirming `payout.create` has exactly one
call site) rather than execution.

**Remaining limitation**: this fix assumes every job requires all its
`CHECKED_OUT` assignments approved before completion — if a future
business rule allows partial completion (e.g., 2 of 3 required movers
is acceptable), this transition logic would need to change.

### P0-03 — Billing Portal

**Files:** `app/api/stripe/billing-portal/route.ts` (new),
`components/DashboardApp.tsx`

New route resolves the authenticated worker's `stripeCustomerId`
server-side (never client-supplied) and creates a real Stripe Billing
Portal session. `components/DashboardApp.tsx`'s "Manage subscription"
button previously always started a brand-new Checkout session — now it
tries the Billing Portal first via a new `openBillingPortal()` helper,
and only falls back to Checkout for a worker who genuinely has no
billing profile yet (a 409 from the new route signals that case
specifically; every other failure still throws normally, so it isn't
silently swallowed).

**Env vars:** none new — reuses the existing `NEXT_PUBLIC_APP_URL`.

**Operational requirement not addressed in code**: Stripe's Customer
Portal must be configured/activated in the Stripe Dashboard (branding,
which features are enabled — cancellation, plan switching, payment
method updates) before this will work in a real environment; that's a
dashboard configuration step, not something expressible in this
codebase.

**Test results:** none, same limitation as above — verified by
inspection (correct customer lookup, correct session creation call,
correct client fallback logic), not execution.

### P0-04 — partner invoicing and collections

**Files:** `app/api/partners/[partnerId]/invoices/route.ts` (new),
`app/api/stripe/webhook/route.ts`, `prisma/schema.prisma`

The previous `/billing` endpoint only summed loads by `createdAt` with
no eligibility rule and created nothing durable — no invoice, no line
snapshot, no way to know later exactly what a partner was billed for.

**Schema additions:** `PartnerInvoice` (period, status, subtotal/fee/
total, Stripe invoice ID, due/finalized/paid/voided timestamps) and
`PartnerInvoiceLine` (one immutable row per billed load, with a
**unique constraint on `loadId`** — this is what makes a load billable
exactly once; a second invoice run with an overlapping period can't
double-bill a load already attached to an earlier invoice). Added
`PartnerInvoiceStatus` enum (`DRAFT`/`FINALIZED`/`SENT`/`PAID`/
`PAST_DUE`/`VOID`) and back-relations on `PartnerOrganization` and
`CarrierRoute`.

**Eligibility, the actual P0-04 fix**: a load is billable only once
it's `paymentStatus: "CAPTURED"` **and** `status` in `DELIVERED`/
`POD_UPLOADED`/`SETTLED` (this schema doesn't have a literal
`COMPLETED` load status — adapted to the real enum rather than the
audit's generic example), filtered on `deliveredAt` within the period
(UTC half-open range), and not already attached to an invoice
(`partnerInvoiceLine: null`) — never by `createdAt`, which would bill
for loads that were posted but never fulfilled or never paid.

**Stripe integration**: creates a real invoice item per billable load,
creates a draft Invoice (`collection_method: "send_invoice"`,
30-day terms), finalizes it, and sends it — using the partner's
underlying `CustomerProfile.stripeCustomerId` (a partner organization
doesn't have its own separate Stripe customer; it bills through the
customer account it belongs to). Added `invoice.paid`/
`invoice.payment_failed`/`invoice.voided` webhook handlers, matched by
our own `stripeInvoiceId` (the durable identifier for that invoice
across every event), reconciling `PartnerInvoice.status` accordingly.

**Failure handling**: the database invoice + frozen line snapshots are
created in one transaction, separately from the Stripe API calls — if
Stripe invoice creation/finalization fails after the database record
exists, the invoice stays in `DRAFT` with an integration alert fired,
rather than losing the billing-period eligibility snapshot and having
to recompute it.

**A real bug found and fixed while building this, unrelated to P0-04
itself**: `captureIntegrationAlert` was being called in the webhook
file (from earlier detention-charge work, several rounds back) but was
never actually imported there — a binding error, not a parse error, so
none of this project's `transpileModule`-based syntax checks had ever
caught it. Found by explicitly checking every import line after this
session's `mapStripeIntentStatus` import turned out fine but the habit
of checking paid off — same class of miss as an `isSemi` bug caught
earlier in this project. Ran a broader heuristic scan for the same
pattern across every payment file touched this session afterward;
everything else checked out as a false positive (comment text, not
real code).

**Env vars:** none new.

**Test results:** none — same environment limitation as every other
item. Verified by inspection: eligibility query logic, transaction
boundaries, Stripe API call sequence (items → draft → finalize → send)
matches Stripe's documented pattern, webhook matching key is correct.

**Explicitly deferred within P0-04's own scope** (the roadmap's Phase 4
also lists these separately): credit memos/refund handling against an
issued invoice, dunning (automated past-due reminders beyond what
Stripe's own portal provides), and a partner-facing invoice UI. None of
these exist yet.

### P0-05 — freight settlement workflow

**A follow-up audit (V23) found two real critical defects in
generation, since fixed** — the routes described below are the
corrected versions.

**Critical Finding 1, fixed — generation was not concurrency-safe.**
The original version read eligible loads outside any transaction, then
updated them by ID list alone without repeating the `settlementId:
null` predicate or verifying every expected row was actually claimed.
Two near-simultaneous generation requests could both read the same
loads, both create a settlement, and the second update could silently
overwrite the first's claim — leaving a settlement's stored totals
disconnected from what its loads actually pointed to. Fixed: the
entire generation flow — eligibility read, claim, and total
computation — now happens inside one `Serializable` transaction. The
claim repeats the full eligibility predicate (not just IDs), and a
strict count check throws (rolling back the whole transaction,
including the settlement row) if fewer rows were claimed than were
read. A losing concurrent request gets a clean, explicitly-retryable
409, never a partially-attached settlement.

**Critical Finding 2, fixed — detention charges were counted but not
durably linked.** The original version added `detentionCharge.
amountCents` to the total and set `includedInPayoutAt`, but nothing
related a `DetentionCharge` to the settlement whose total included it
— there was no way to reconstruct which charges made up a given
settlement, and `includedInPayoutAt` was being set at *generation*,
before approval or payment ever happened, which was itself misleading.
Added `SettlementDetentionLine` — an immutable snapshot row per
included charge, with a **unique constraint on `detentionChargeId`**
that makes double-settlement of the same charge impossible at the
database level, not just application logic. `includedInPayoutAt` now
genuinely means "paid out" — it's set in the pay route at
`TRANSFERRED`, not at generation; `SettlementDetentionLine`'s own
existence is what now tracks "claimed by a pending settlement."

**Approval now reconciles totals before allowing `SCHEDULED`** (a
V23-requested addition): recomputes gross/net from the settlement's
actually-attached loads and detention lines and refuses to approve
with a 409 if stored totals have drifted from what they should be —
approval is the last real checkpoint before money moves, so it's the
right place to catch that rather than trusting numbers written earlier
without re-checking them.

**Files:** `app/api/settlements/route.ts`,
`app/api/settlements/[settlementId]/approve/route.ts`,
`app/api/settlements/[settlementId]/pay/route.ts`,
`prisma/schema.prisma`

**Schema additions (this fix):** `SettlementDetentionLine` model;
`Settlement.detentionLines` and `DetentionCharge.settlementLine`
back-relations.

**Explicitly accepted, not fixed, per the audit's own verdict**: the
pay route's stuck-`PROCESSING` reconciliation still scans only the
most recent 100 Stripe transfers — a busy account could push the
matching transfer outside that window. The audit marked this "Pass
with operational limitation," not a required correction, since fixing
it properly would mean adding a dedicated operation-ledger table (the
same pattern `PayoutOperation` uses for individual worker payouts),
which is a larger change than this pass's scope. Documented here as a
known, accepted gap rather than silently left unaddressed.

**Test results:** none, same limitation as every item in this audit.
Verified by inspection: the transaction's claim-then-recount logic,
the unique constraint's role in preventing double-claims, and the
approval reconciliation math were traced by hand against the exact
scenarios the audit's required-tests list describes (concurrent
generation, detention-only settlements, totals drift) — not executed
against a real concurrent load.



**Files:** `app/api/settlements/route.ts` (new, generate),
`app/api/settlements/[settlementId]/approve/route.ts` (new),
`app/api/settlements/[settlementId]/pay/route.ts` (new),
`prisma/schema.prisma`

The `Settlement` model existed with nothing that ever created,
approved, or paid one — a driver's freight earnings had no path to
actually being settled. The reconciliation *side* already existed
(`transfer.created`/`transfer.reversed` webhook handlers already
updated `Settlement` correctly, from earlier payout-safety work) —
only generation/approval/payment was missing.

**Schema addition:** `Settlement.approvedAt`/`approvedById` — a
settlement aggregates multiple loads and real money movement, so it
gets the same explicit admin-approval gate used everywhere else in
this codebase (detention charges, document review, worker status
changes) rather than auto-paying once generated.

**Generate** (`POST /api/settlements`): eligibility mirrors the
partner-invoice fix exactly — `paymentStatus: "CAPTURED"` and a real
delivered status, filtered by `deliveredAt` within the period, with
`settlementId: null` preventing a load from being pulled into two
settlements. **Also closes a named gap from several rounds back**:
sweeps in any `CAPTURED` detention charges tied to the driver's loads
that haven't been folded into a payout yet
(`includedInPayoutAt: null`) — this is the actual link from paid
detention to driver settlement that was flagged as missing
infrastructure when detention charging was first built, and marks
those charges `includedInPayoutAt` so they can't be swept into a
second settlement either.

**Approve** (`POST /api/settlements/[id]/approve`): `PENDING` →
`SCHEDULED`, admin-only, records who approved and when.

**Pay** (`POST /api/settlements/[id]/pay`): a real Stripe Transfer to
the driver's connected account, closely mirroring
`payouts/[payoutId]/pay`'s structure — same Connect-onboarding and
suspension checks, same `TRANSFERRED`-not-`PAID_OUT` distinction (this
confirms movement to the Connect balance, not confirmed bank arrival),
same idempotency-key-survives-retries approach. One deliberate
simplification versus the payout route: no `PayoutOperation`-style
durable pre-Stripe-call ledger, since settlements don't have
bonus-recovery reservations to protect — `Settlement.idempotencyKey`
itself doubles as the atomic claim marker, and a stuck `PROCESSING`
settlement reconciles by searching Stripe's transfer list for
matching metadata, the same fallback the payout route uses when it
has no operation record.

**Env vars:** none new.

**Test results:** none, same limitation as every other item this
pass. Verified by inspection: eligibility queries, the transaction
boundary around load/detention-charge attachment, and the transfer
call sequence match the already-proven payout-route pattern closely
enough that the same reasoning applies.

**Explicitly deferred within P0-05's own scope**: manual adjustment
entries against a settlement (the `adjustmentsCents` field exists and
is always `0` from generation — nothing yet lets an admin add a
correction before approval), and a driver-facing settlement
history/detail UI.

### P1-01 and P1-02 — manual-capture lifecycle and stale idempotency (fixed together)

**A follow-up audit (V25) found one critical financial-state-corruption
bug and three other real gaps in this work, since fixed.**

**Critical, fixed — a successfully-paid job could be marked
CANCELED.** Both cancel routes treated a Stripe "already succeeded"
error the same as "already canceled" and unconditionally wrote
`CANCELED` locally either way — meaning an actually-captured payment
could get recorded as canceled in our own database while Stripe
correctly still shows it as succeeded. Fixed: after any cancellation
error, the intent is now *retrieved* from Stripe, and local state is
derived from what Stripe actually reports — `CANCELED` is only ever
written when Stripe confirms canceled; a succeeded intent is recorded
as `CAPTURED` with an error pointing at the refund flow instead.

**High, fixed — attempt-number allocation wasn't atomic.** The
original `count()+1` approach could let two near-simultaneous requests
read the same count and collide. Added `lib/payment-attempts.ts`:
claims the next attempt via `create()` and retries on a `P2002`
unique-constraint conflict (the `@@unique([jobId/loadId,
attemptNumber])` constraint is what makes this genuinely atomic — only
one concurrent insert for a given number can ever succeed). The row is
claimed and durably recorded *before* the Stripe call now, not after;
`operationStatus` (`PROCESSING`/`CREATED`/`FAILED`/`CANCELED`) tracks
the claim's own lifecycle, separate from `paymentStatus`, which tracks
the actual Stripe state.

**High, fixed — the attempt ledger wasn't webhook-authoritative.**
`PaymentAttempt` was never updated by any webhook handler, so it went
stale the moment a payment progressed past creation. Added
synchronization to all five relevant handlers
(`succeeded`/`payment_failed`/`canceled`/`amount_capturable_updated`/
`processing`) — the same handlers already updating `Job`/
`CarrierRoute`.

**Medium, fixed — the expiry cron measured the wrong clock.** It used
`Job.updatedAt`/`CarrierRoute.updatedAt`, which reflects *any*
modification to the parent record, not the moment the current
authorization actually became capturable — an unrelated later edit
could reset the clock and hide a genuinely aging authorization. Added
`PaymentAttempt.authorizedAt`, set by the
`amount_capturable_updated` handler (the same change that fixed the
webhook-sync gap above), and the cron now measures from that,
filtered to the attempt whose `stripePaymentIntentId` still matches
the parent record's own (so a superseded earlier attempt on the same
job/load is never what gets measured).

**Medium, documented but not executed — the XOR ownership
constraint.** Prisma can't express "exactly one of jobId/loadId" as a
schema-level constraint. The required correction is a raw SQL `CHECK`
constraint added via migration:

```sql
ALTER TABLE "PaymentAttempt"
ADD CONSTRAINT "PaymentAttempt_exactly_one_owner"
CHECK (
  ("jobId" IS NOT NULL AND "loadId" IS NULL) OR
  ("jobId" IS NULL AND "loadId" IS NOT NULL)
);
```

This needs to be added as a custom migration step after `prisma
migrate dev` generates the base migration for the schema changes in
this pass — Prisma doesn't have a schema-level way to express this,
so it can't be written directly in `schema.prisma`. Every code path
in this codebase already only ever sets one of the two fields, but
that's an application-level guarantee, not a database-level one, until
this runs.

**Files:** `prisma/schema.prisma`, `lib/payment-attempts.ts` (new),
`app/api/stripe/job-payment-intent/route.ts`,
`app/api/stripe/driver-payment-intent/route.ts`,
`app/api/stripe/job-payment-intent/cancel/route.ts`,
`app/api/stripe/driver-payment-intent/cancel/route.ts`,
`app/api/stripe/webhook/route.ts`,
`app/api/cron/authorization-expiry/route.ts`

**Schema additions (this fix):** `PaymentAttempt.idempotencyKey`
(unique), `operationStatus` (new
`PaymentAttemptOperationStatus` enum), `authorizedAt`,
`failureReason`; `stripePaymentIntentId` is now nullable (the row
exists before Stripe returns anything); `status` renamed to
`paymentStatus` for clarity against the new `operationStatus`.

**Test results:** none, same limitation as every item in this audit.
Verified by inspection and by explicitly re-checking every import
across all seven touched files by hand (a discipline adopted after an
earlier missing-import bug in this project) — all clean.

### P1-03 and P1-04 — authoritative receipts (fixed together)

These needed the same fix, since jobs and freight loads share the exact
same `payment_intent.succeeded` webhook code path.

**Files:** `prisma/schema.prisma` (new `PaymentTransaction` model),
`app/api/stripe/webhook/route.ts`, `lib/email/templates/payments.ts`,
`app/api/jobs/[jobId]/capture-payment/route.ts`

**The actual bug**: receipts were sent immediately from the capture
route using `finalTotalCents` — our own computed number — with nothing
persisted and no link to what Stripe actually confirmed.
`amount_received` can differ from what was requested (e.g. a partial
capture), and there was no stored charge ID, payment method summary, or
hosted receipt URL anywhere.

**Fixed**: added `PaymentTransaction` — one row per confirmed charge,
unique on `stripeChargeId` (so a redelivered webhook event finds the
existing record and skips re-processing rather than erroring or
double-emailing). Receipt generation moved entirely into the webhook's
`payment_intent.succeeded` handler
(`createPaymentTransactionAndSendReceipt`) — retrieves the PaymentIntent
with its charge and payment-method details expanded, persists the real
`amount_received`, card brand/last4, and Stripe's own `receipt_url`,
and only then sends the receipt, built from that persisted record. The
capture route no longer sends a receipt at all — only the review
request, which is genuinely tied to job completion rather than to
Stripe's confirmation specifically.

**P1-04 folded in for free**: since jobs and freight loads hit the
identical webhook code path, the same fix handles both — a
`PaymentTransaction` is created and a receipt sent for a load exactly
the same way as a job. One assumption I made while writing this turned
out to be wrong and worth being honest about: I initially assumed
freight loads had no resolvable "poster" contact to notify and planned
to defer that piece — checking the schema directly (rather than trusting
that assumption) showed `CarrierRoute.postedByUserId` already exists and
resolves cleanly, so the freight receipt notification is fully wired,
not deferred.

**A second real missing-import bug, caught before it shipped this
time**: while wiring the webhook to call `paymentReceiptTemplate`, an
explicit import check (a discipline adopted after an earlier miss in
this same file) found it wasn't actually imported there yet. Fixed
before running any further checks, not discovered after the fact.

**Env vars:** none new.

**Test results:** none, same limitation as every item in this audit.

### P1-03/P1-04 verification pass — one genuine gap found and closed

A reviewer asked me to specifically verify five things before treating
P1-03/P1-04 as closed, rather than accept the architecture as
sufficient on its own. Checked each directly against the code:

- **Duplicate webhook events ignored via `stripeChargeId`** — confirmed
  already correct: the existing-record check happens before
  `PaymentTransaction.create()`, not after.
- **Receipt emails only sent after the DB write commits** — confirmed
  already correct: `queueNotification` is only ever reached after
  `paymentTransaction.create()` has already succeeded (a thrown error
  from `create()` exits the function before that point; there's no
  try/catch swallowing it in between).
- **Failed email delivery can't roll back or invalidate the recorded
  payment** — confirmed by reading `queueNotification`'s actual
  implementation directly rather than trusting an earlier description
  of it: its outer `try/catch` genuinely never rethrows, and there's no
  wrapping `$transaction()` linking the DB write to the notification
  that a failure could even theoretically unwind.
- **Receipt generation uses only the persisted `PaymentTransaction`
  record** — confirmed already correct: the receipt is built from
  `transaction.amountReceivedCents`/`paymentMethodBrand`/etc., never
  from the live `charge`/`intent` objects directly.
- **Refund events reconcile with `PaymentTransaction`** — **this one
  was a genuine gap**. The existing `charge.refunded` handler updated
  `Job`/`CarrierRoute.paymentStatus` but never touched
  `PaymentTransaction.refundedAmountCents` at all, and no customer was
  ever notified that a refund happened. Fixed: the handler now updates
  `refundedAmountCents` from Stripe's own `charge.amount_refunded`
  (keeping `PaymentTransaction` — the receipt system's source of
  truth — from silently disagreeing with reality), and added
  `refundNoticeTemplate` so both the job customer and the freight
  load's poster actually get told about a refund, which previously
  happened silently.

**Files:** `app/api/stripe/webhook/route.ts`,
`lib/email/templates/payments.ts`

**Test results:** none, same limitation as every item in this audit.

### P1-05 — general refund API (the actual creation half, not just reconciliation)

The previous round only fixed reconciliation (the webhook recording a
refund that already happened in Stripe). This round builds the missing
half: a real, authorized, auditable operation for an admin to actually
initiate one. Correctly identified by an outside audit as still open —
there was no route anywhere except the screening-charge-specific one.

**Files:** `prisma/schema.prisma` (new `PaymentRefund` model),
`app/api/admin/payment-transactions/[transactionId]/refund/route.ts`
(new), `app/api/stripe/webhook/route.ts`

**Schema**: `PaymentRefund` — one row per refund *operation* (not per
cumulative state), with `idempotencyKey` (unique) and `stripeRefundId`
(unique), a `reason` required and persisted, `requestedByUserId`, and
its own lifecycle (`PROCESSING`/`PENDING`/`SUCCEEDED`/`FAILED`/
`CANCELED`) independent of `PaymentTransaction.refundedAmountCents`,
which stays as the cumulative total.

**The route** (`POST /api/admin/payment-transactions/[id]/refund`),
unified across jobs and freight loads since both share
`PaymentTransaction`: admin-only; requires a non-empty reason; computes
refundable balance as `amountReceivedCents` minus everything already
`SUCCEEDED` **or** `PENDING`/`PROCESSING` (in-flight reservations count
against the balance too, not just completed ones); rejects zero,
negative, or over-balance amounts; claims the `PaymentRefund` row
inside a `Serializable` transaction *before* calling Stripe, so a
losing concurrent request gets a clean, explicitly-retryable 409
instead of both requests reading the same balance and over-refunding.
Never marks `Job`/`CarrierRoute` `REFUNDED` optimistically — that
stays the webhook's job alone, exactly as capture already works.

**A real bug in my own new code, found and fixed before finalizing,
not after**: my first version gated the webhook's customer-notification
logic on "did this refund's status change since we last saw it." But
a refund that succeeds *synchronously* in Stripe's own API response
(the common case for card refunds) already has its `PaymentRefund` row
set to `SUCCEEDED` by the route itself, before the webhook event ever
arrives — meaning the webhook would see no change and skip sending the
notification entirely, for the *most common* case, not an edge case.
Fixed: the database write still only happens on a genuine status
change (avoiding redundant writes/audit rows), but the
notification/alert logic no longer depends on that — it fires whenever
the current status is `SUCCEEDED`/`FAILED`, relying on
`queueNotification`'s own idempotency-key deduplication (checked
directly in `lib/notifications`, not assumed) to prevent an actual
duplicate send if this ever runs more than once for the same refund.

**The two secondary risks the audit flagged, both addressed:**
- **6.1 (cumulative-total notification bug)**: a second partial refund
  would have described the running total, not what that specific
  refund was for. Fixed structurally — the webhook's refund
  notification is now built entirely from the individual
  `PaymentRefund.amountCents`, never `charge.amount_refunded`.
- **6.2 (blanket bonus recovery on any refund)**: previously triggered
  full bonus recovery on *every* refund webhook, partial or full, with
  no confirmed business rule behind that. Scoped to full refunds only
  as the safer default; a partial refund now fires an integration
  alert for manual review instead of silently reversing a bonus that
  may not warrant it. This is a policy choice flagged for confirmation,
  not a decision this pass is positioned to make unilaterally.

**Unmatched refund events are flagged, not silently dropped** — a
`refund.updated`/`refund.created` event with no matching
`PaymentRefund` (e.g., a refund issued directly in the Stripe
dashboard, outside this API) fires an integration alert per the
audit's explicit requirement.

**Env vars:** none new.

**Test results:** none, same limitation as every item in this audit.
Verified by inspection, including explicitly re-checking every import
across both touched files by hand.

### P1-05 verification pass — six items checked, two real gaps found and fixed

Before treating P1-05 as closed, went through six specific verification
items against the actual code rather than accepting the architecture as
self-evidently correct.

1. **Atomic refund claim** — confirmed already correct: the
   `PaymentRefund` row is created inside the `Serializable` transaction,
   before the Stripe call, which is a separate step afterward.
2. **Webhook reconciliation and duplicate handling** — confirmed already
   correct on both counts: `charge.refunded` updates
   `PaymentTransaction.refundedAmountCents` for every refund (per
   Stripe's documented event behavior — not independently confirmed
   against a live Stripe account, since nothing here can make that
   call), and duplicate delivery protection is handled generically for
   *every* event type by `ProcessedStripeEvent`, keyed on Stripe's own
   event ID — it isn't event-type-specific, so the new
   `refund.updated`/`refund.created` handlers inherited this protection
   automatically, with no special-casing needed.
3. **Partial refund validation** — confirmed already correct: the
   balance check rejects any amount exceeding
   `amountReceivedCents` minus everything already `SUCCEEDED` *or*
   `PENDING`/`PROCESSING` (so in-flight refunds count against the
   balance too), and a `FAILED` refund correctly doesn't lock up
   balance it never actually used.
4. **Audit logging completeness — a real gap, now fixed.** The
   `REFUND_FAILED` and `REFUND_SUBMITTED_TO_STRIPE` entries (and the
   webhook's own `REFUND_SUCCEEDED`/`REFUND_FAILED` entry) didn't embed
   the refund amount or reason directly — they were only derivable by
   joining back to the `PaymentRefund` row via `entityId`, not
   self-contained the way the verification asked for. Fixed all three
   to include `amountCents`/`reason`/`result` directly. The webhook's
   own entry was also missing `actorId` entirely (a webhook-triggered
   status change has no directly-authenticated human actor at that
   moment) — fixed by attributing it to `paymentRefund.requestedByUserId`,
   the person who actually initiated the underlying refund, which is
   the more useful and accurate answer to "who initiated this" than
   leaving it blank.
5. **Permission enforcement** — confirmed by reading `requireRole`'s
   actual implementation: any role not explicitly in the allowed list
   is rejected with 403, and the refund route only allows `ADMIN`. (This
   system has no distinct "support" role to test against specifically —
   only `CUSTOMER`/`MOVER`/`DRIVER`/`ADMIN` exist.)
6. **End-to-end scenarios — not executed, traced by hand instead, and
   that distinction matters.** No test runner in this environment has
   network access to reach a real or test-mode Stripe account, so none
   of the following were actually run:
   - *Full refund, multiple partial refunds*: logic traced correctly —
     each request re-sums reservations fresh, so a second partial
     refund's balance check accounts for the first.
   - *Duplicate refund request*: two concurrent requests hitting
     `Serializable` isolation — one succeeds, the other gets a
     serialization conflict mapped to a clean 409 with the response
     already saying it's safely retryable — but this depends on the
     underlying database actually enforcing serializable isolation
     correctly, which isn't something a code read confirms.
   - *Network timeout during the Stripe call*: the `catch` block
     correctly marks the row `FAILED` and releases nothing else — but
     whether a genuine network timeout (as opposed to an explicit
     Stripe error response) is caught by the same `try/catch` the way
     an explicit rejection is has not been exercised.
   - *Duplicate webhook delivery*: covered by item 2's mechanism, same
     "traced, not run" caveat.
   - *Refund notification email, updated receipt/history*: the
     notification call is reached and templated correctly by
     inspection; whether it actually renders and delivers correctly
     end-to-end has not been observed.

**Files touched this pass:**
`app/api/admin/payment-transactions/[transactionId]/refund/route.ts`,
`app/api/stripe/webhook/route.ts`

**Remaining from the payment audit**: P1-06 through P1-08, and all 4
P2 findings. The audit's own **NO-GO** verdict for unsupervised
production payments stands until those are addressed — and, per item 6
above, until the end-to-end scenarios are actually run somewhere with
real Stripe connectivity, not just traced by hand.

### P1-05 — one more real bug found: non-deterministic idempotency key

The refund route's Stripe idempotency key embedded `Date.now()`
directly: `` `refund:${transaction.id}:${Date.now()}:${authed.userId}` ``.
This defeats the entire point of an idempotency key — if a client
retries after a network timeout where Stripe actually processed the
refund but the response never reached the caller, the retry would
compute a brand-new key (a new timestamp) and Stripe would process a
genuinely second, separate refund. This is the same class of bug
already found and fixed elsewhere in this exact codebase (Stripe
Checkout idempotency, several rounds back) — worth having caught
sooner, but caught now rather than left in place.

**Fixed**: the `PaymentRefund` row's own identity is generated first
(via `randomUUID()`, explicitly imported from `"crypto"` — matching
this codebase's established convention in `lib/auth.ts` and the
webhook signature-verification routes, rather than relying on the bare
global), and the idempotency key is derived from that stable ID with
zero timestamp component: `` `refund:${refundId}` ``. The key is now
permanently tied to that specific persisted row from the moment of
creation, not to when the request happened to arrive.

**Files:** `app/api/admin/payment-transactions/[transactionId]/refund/route.ts`

### P1-06 — subscription webhook status mapping collapsed most states

**The exact bug the audit described, confirmed by direct inspection**:
`const status = sub.status === "active" ? "ACTIVE" : "PAST_DUE";` — every
non-active Stripe subscription state (`trialing`, `incomplete`,
`incomplete_expired`, `paused`, `unpaid`, `canceled`) collapsed into
`PAST_DUE`. Anything gating Billing Portal access or plan features on
this field could grant or deny access incorrectly — a trialing worker
looks identical to one who's actually behind on payment.

**Files:** `prisma/schema.prisma`, `lib/stripe.ts`,
`app/api/stripe/webhook/route.ts`

**Schema**: `SubscriptionStatus` expanded with `INCOMPLETE_EXPIRED`,
`TRIALING`, `PAUSED` (`INCOMPLETE`/`ACTIVE`/`PAST_DUE`/`CANCELED`/
`UNPAID` already existed).

**Fixed**: added `mapStripeSubscriptionStatus()` in `lib/stripe.ts` —
an explicit switch covering every real Stripe subscription status,
alongside the existing `mapStripeIntentStatus()`. Has a defensive
`default` case falling back to `PAST_DUE` with a comment explaining why:
this environment can't run a full type-check against the real Stripe
SDK types to confirm the switch is truly exhaustive, and Stripe could
add a new status later regardless.

**The rest of the required correction**:
- `invoice.paid`/`invoice.payment_failed` (already existed for partner
  billing) now also update `WorkerProfile.subscriptionStatus` when
  `invoice.subscription` is present — distinguishing a subscription
  invoice from a partner invoice by that field, so both event types
  share the same handler without conflicting.
- Added `customer.subscription.paused`/`customer.subscription.resumed`
  handlers explicitly, rather than relying solely on
  `subscription.updated` to always carry these transitions.
- Added `checkout.session.expired` handling for abandoned subscription
  checkouts — previously invisible; now fires an integration alert with
  the worker ID so an abandoned signup isn't silently untracked.

**Not touched, flagged as a pre-existing, non-blocking gap**: the admin
subscription-stats dashboard (`/api/admin/subscriptions`) only buckets
workers into `active`/`pastDue` counts — a worker in `TRIALING` or
`PAUSED` won't crash anything (the filter just returns them in neither
bucket), but won't be visible in that view either. A nice-to-have
dashboard enhancement, not a correction the audit required, and not
attempted here.

**Env vars:** none new.

**Test results:** none, same limitation as every item in this audit.

**Follow-up fix**: the default case silently returned `PAST_DUE` with
no logging at all for an unrecognized future Stripe status. Fixed to
fire an integration alert (still returning `PAST_DUE` as the actual
conservative value — something has to be returned — but the occurrence
itself is now visible instead of invisible).

**A much bigger finding surfaced while making that one-line change**:
implementing it required calling `captureIntegrationAlert`, which
uncovered that `area: "payment"` and `area: "billing"` — used across
**21 call sites** throughout this entire payment-audit sequence — were
never actually valid values of that function's `area` parameter type
(`"stripe" | "payout" | "resend" | "twilio" | "checkr" | "fmcsa" |
"insurance" | "load-board"` — neither `"payment"` nor `"billing"` was
in it). A real `tsc`/`next build` would have rejected every one of
those 21 calls. This was never caught because it requires cross-file
type resolution — every syntax check run throughout this whole audit
(`transpileModule`, used for speed since no `node_modules` exists in
this sandbox) checks one file in isolation and has no way to see
another file's type definitions. Fixed by expanding the union type to
include `"payment"` and `"billing"` — both are clearly meaningful,
established categories given 21 real uses, not typos — rather than
rewriting every call site to fit awkwardly into `"stripe"`/`"payout"`.
Confirmed the fix resolves every previously-invalid call by re-checking
the complete inventory of `area:` values used anywhere in the codebase
against the new type afterward, not just the ones first noticed.

**Files:** `lib/stripe.ts`, `lib/monitoring.ts`

**This is also a standing limitation worth naming plainly**: this
`transpileModule`-based checking approach, used throughout the entire
payment audit for lack of an installable `node_modules`, cannot catch
cross-file type errors like this one. A real `npm install && npx tsc
--noEmit` (or `next build`) is the only way to be confident no other
instances of this same class of gap exist elsewhere in this codebase.

**Remaining from the payment audit**: P1-07, P1-08, and all 4 P2
findings. The audit's own **NO-GO** verdict for unsupervised production
payments stands until those are addressed.

### P1-07 — subscription confirmation showed list price, not actual billed amount

**Confirmed by direct inspection**: the confirmation email used a
hardcoded `listPriceCents` map keyed by plan name — ignoring fleet
vehicle count multipliers, any discount or promotion code, taxes, and
prorations entirely.

**Fixed**: replaced the hardcoded map with `session.amount_total` —
already present on the `Stripe.Checkout.Session` object this handler
receives, and already reflecting everything that was actually
charged (fleet vehicle count, discounts, promo codes, tax), with no
separate invoice lookup needed. Falls back to `0` only if Stripe
hasn't finalized an amount on the session (rare), firing an
integration alert in that case rather than silently showing a wrong
number.

**A wording problem I caught while making this change, not a separate
bug report**: the template said `(${money(amountCents)}/mo)` — implying
the number shown is the ongoing recurring rate. But `amount_total` is
the *checkout* total, which can genuinely differ from the steady-state
monthly price (a first-month promo code, a trial, a proration).
Substituting the real total into wording that claims it's the
recurring "/mo" rate would have misrepresented it in exactly the
scenario this fix was supposed to correct. Reworded to describe what
was actually charged today, not what happens monthly going forward.

**Files:** `app/api/stripe/webhook/route.ts`,
`lib/email/templates/payments.ts`

**Env vars:** none new.

**Test results:** none, same limitation as every item in this audit —
and, per the standing note above, this pass's `transpileModule`-based
checks cannot catch cross-file type errors either; a real `npm ci &&
npx prisma generate && npx tsc --noEmit && npm test && npm run build`
in an environment with dependencies installed remains the only way to
be confident before production sign-off, for this fix and everything
else in this audit.

### P1-07 follow-up — checkout handler hardcoded ACTIVE, overwriting real subscription state

**Confirmed by direct inspection**: `checkout.session.completed`'s
subscription branch wrote `subscriptionStatus: "ACTIVE"` unconditionally.
A subscription with a trial period genuinely starts `TRIALING`, not
`ACTIVE` — and since Stripe doesn't guarantee webhook delivery order, a
`customer.subscription.created` event correctly setting `TRIALING`
could arrive first, only to have this handler overwrite it to `ACTIVE`
moments later. This also directly conflicted with the whole point of
P1-06's centralized status mapping — two different rules deciding the
same field.

**Fixed**: retrieves the actual Stripe subscription and maps its real
status via `mapStripeSubscriptionStatus()` — the same mapper P1-06
introduced — instead of a hardcoded value. Because this does a fresh
`stripe.subscriptions.retrieve()` call rather than trusting a
potentially-stale webhook payload, it reflects the subscription's
actual current state regardless of which webhook event happens to
arrive first, which is what actually closes the delivery-order race,
not just the hardcoding itself.

**Files:** `app/api/stripe/webhook/route.ts`

**Follow-up hardening**: the previous fix still skipped the fresh
`stripe.subscriptions.retrieve()` call whenever `session.subscription`
already came in as an expanded object, using that snapshot directly
instead. But an expanded object embedded in a webhook payload is still
just a snapshot from whenever Stripe serialized *that specific event*
— it can be stale relative to the subscription's actual current state,
for the same webhook-ordering reason the original fix was about. Now
always resolves the subscription ID first and always calls
`retrieve()`, regardless of what shape `session.subscription` arrived
in — this is what fully removes the webhook-ordering dependency rather
than only partially closing it.

### P1-08 — payout lifecycle never reached its true terminal state

**Confirmed by direct inspection**: `PAID_OUT` was referenced only in
guard conditions (`"already paid" if status is TRANSFERRED or
PAID_OUT`) in both `payouts/[id]/pay` and `settlements/[id]/pay` —
grepped every write of that literal string across the entire codebase
and found none. `TRANSFERRED` only confirms money reached a worker's
Stripe Connect *balance*; nothing ever advanced that to confirm it
actually reached their *bank account*.

**Fixed**: added `payout.paid`/`payout.failed` handlers to the
webhook, matched via `event.account` (the connected account a Connect
event pertains to) against `WorkerProfile.stripeAccountId`.

**An important limitation, stated plainly rather than glossed over**:
a Stripe "Payout" object represents a *sweep* of a connected account's
entire available balance to their bank on Stripe's own schedule — it
has no direct reference back to which specific `Transfer`(s)
contributed to that balance. There is no precise, official way to say
"this `payout.paid` event corresponds to exactly this `Payout`/
`Settlement` row." The fix advances *every* currently-`TRANSFERRED`
row for that worker to `PAID_OUT` as a reasonable approximation
(Stripe's default behavior sweeps the full balance) — which can be
wrong in edge cases: a worker with a rolling reserve, an unusual
manual payout schedule, or a partial balance hold could have some
`TRANSFERRED` funds marked `PAID_OUT` before they've actually reached
that specific bank deposit. Exact reconciliation would require tracing
the connected account's balance transaction history — a materially
larger feature than this pass's scope, and not attempted here.

`payout.failed` deliberately does **not** revert `TRANSFERRED` —
the original Transfer to the connected account's balance already
succeeded regardless of whether Stripe's own downstream bank payout
failed. Reverting status here would incorrectly imply the transfer
itself failed. Fires an integration alert for manual review instead.

**Operational requirement, not expressible in code**: `payout.paid`/
`payout.failed` are Connect-scoped events — Stripe's dashboard needs
this webhook endpoint configured to listen for events on connected
accounts, not just the platform's own account, or these will never
arrive here regardless of how correct the handler is.

**Files:** `app/api/stripe/webhook/route.ts`

**Env vars:** none new.

**Test results:** none, same limitation as every item in this audit —
and this one in particular has no way to be exercised without a real
Stripe Connect test-mode account with actual payout scheduling.

### P1-08 follow-up — misleading wording, and a gap I found beyond what was asked

**Confirmed by direct inspection**: the `TRANSFERRED` email said "has
been sent to your bank account" — genuinely wrong at that stage, since
`TRANSFERRED` only confirms money reached the Connect balance, not the
bank. Fixed exactly per the suggested wording: "transferred to your
Stripe payout balance. Bank arrival depends on Stripe's payout
schedule."

**A bigger gap found while fixing that, not something the audit
explicitly flagged**: `payoutStatusTemplate`'s type signature didn't
even include `"PAID_OUT"` as a possible status — meaning there was no
notification of any kind for the actual bank-arrival confirmation this
whole feature exists to represent. The worker would learn their money
was "sent" (misleadingly, per the bug above) and then simply never
hear anything else. Added a real `PAID_OUT` case ("has been deposited
to your bank account") and wired the webhook's `payout.paid` handler to
actually send it — per affected `Payout`/`Settlement` row individually,
since a single Stripe payout sweep can advance several rows for one
worker at once, each a genuinely distinct amount worth its own notice.

**Schema**: added `paidOutAt`/`stripePayoutId` to both `Payout` and
`Settlement`, distinct from the existing `paidAt` (which is set at
`TRANSFERRED` time, not renamed or repurposed, to avoid a larger,
riskier change than what was actually needed).

**A missing-import bug, caught by explicit verification, same as
before**: `payoutStatusTemplate` was used in the new notification code
but not imported — caught by re-running the explicit import check
against actual usage, the same discipline that's now caught this exact
class of bug several times in this file specifically.

**Files:** `prisma/schema.prisma`, `lib/email/templates/payments.ts`,
`app/api/stripe/webhook/route.ts`

**Test results:** none, same limitation as every item in this audit.

### P2-01 — partner billing date inputs, now validated

**Confirmed by direct inspection**: `new Date(searchParams.get("from")!)`
with no validation at all — a missing or malformed param silently
became `Invalid Date` and propagated into a query rather than a clear
error. No max range, no boundary convention, no pagination.

**Fixed**: this is the read-only report route
(`GET /api/partners/[partnerId]/billing`), distinct from the real
`POST /api/partners/[partnerId]/invoices` generation route built for
P0-04, which already had proper validation — this older route just
hadn't been brought up to the same standard. Added Zod `datetime()`
validation, a UTC half-open range (`[from, to)`), a
`MAX_PERIOD_DAYS = 92` cap, and pagination on line items (totals are
computed over the *full* period via a separate aggregate query, not
just the current page — otherwise `subtotalCents` would silently only
reflect whatever page happened to be requested).

**Files:** `app/api/partners/[partnerId]/billing/route.ts`

### P2-02 — dashboard mock data, made honest rather than fully rebuilt

**A more serious version of the audit's own finding, confirmed by
inspection**: the Indianapolis market-stats row wasn't gated by
`NEXT_PUBLIC_DEMO_MODE` *at all* — hardcoded numbers (186 movers, 42
drivers, $18,420 revenue) shown unconditionally, with no "(demo data)"
label, indistinguishable from genuine live data during any review.
Several other instances of the same pattern turned up while checking
the surrounding context: three mover-dashboard metrics ("$576 this
week," "14 available jobs," "$448 next payout"), a booking
"Authorize... with Stripe" button with no `onClick` handler at all
sitting atop a form with no job-creation logic behind it either, a
matching "Accept" button on a hardcoded job feed, a "Settlements" tab
(among four others) with no click handler — confirmed genuinely
unfinished, not a stylistic choice, since a working tabbed pattern
(Box truck/Semi) exists later in the same file — and two admin buttons
("Post partner job," "Manage market rules") with no handlers either.

**What was fixed vs. not**: labeled every instance found as
illustrative/preview/not-yet-built, and disabled the buttons that
looked clickable but did nothing — this is the proportionate fix
matching the audit's "put behind `NEXT_PUBLIC_DEMO_MODE`" framing.
**Not attempted**: actually building the missing features these
elements gesture at (a full Stripe Elements card-collection flow, a
real market-stats aggregation endpoint, functioning Vehicles/Routes/
Documents/Settlements/Membership tab content, a real partner-job
posting flow). Each of those is a genuine feature build, not a data-
honesty fix, and wasn't attempted here. This also does not claim to be
an exhaustive sweep of every mock value in this large file — it's
what turned up while directly investigating the audit's specific
finding and its immediate surrounding context.

**Files:** `components/DashboardApp.tsx`

### P2-03 — payment test coverage: a genuine, honest start, not comprehensive

**Confirmed by inspection**: the `tests/` directory had pure-function
tests only (pricing, detention, load-schema validation) — nothing
touching PaymentIntent creation, capture, webhook replay, subscription
lifecycle, refunds, transfers, partner invoices, or settlements, and no
Stripe-client or database mocking infrastructure exists at all.

**What this pass actually adds**: `tests/payments/status-mapping.test.ts`
— real, passing-by-construction unit tests for `mapStripeIntentStatus`
and `mapStripeSubscriptionStatus`, chosen specifically because they're
pure functions needing no mocking, unlike nearly everything else this
finding covers. Each test ties back to the specific bug it guards
against regressing (e.g., confirming `requires_capture` maps to
`AUTHORIZED` — the actual P0-01 fix — and that no non-active
subscription state collapses into `PAST_DUE` — the P1-06 fix).

**Deliberately not attempted**: building the Stripe-client-mock plus
database-integration test infrastructure the audit actually asks for,
covering every state transition and idempotency branch across the
whole payment system. That's a substantial testing-infrastructure
project in its own right — attempting a rushed, partial version of it
risked producing tests that look like coverage without actually
exercising the real risk (concurrency, webhook ordering, Stripe error
handling) this audit cares about most. Flagged honestly as not done,
rather than passed off as complete.

**Files:** `tests/payments/status-mapping.test.ts` (new)

### P2-04 — build/test verification: still not possible in this environment

No change from every prior note in this document: this sandbox has no
installable `node_modules` (network disabled for the bash tool), so
`npm ci`, `npx tsc --noEmit`, `npm test`, and `npm run build` have
never actually been run against any of this session's work. Every
"ALL CLEAN" result throughout this entire payment audit reflects a
single-file, syntax-only check (`transpileModule`), which — as the
`area: "payment"`/`"billing"` type-mismatch found earlier in this audit
demonstrated concretely — cannot catch cross-file type errors. This is
the real gate before any of this is production-verified, not a
formality.

**All 4 P2 findings have now been addressed** — P2-01 fully, P2-02 and
P2-03 with explicit, honest boundaries around what was and wasn't
done, and P2-04 remains exactly what it always was: an environmental
limitation requiring a real CI environment, not something fixable from
here. The audit's own **NO-GO** verdict for unsupervised production
payments stands until a real `npm ci && npx prisma generate && npx tsc
--noEmit && npm test && npm run build` passes, and until end-to-end
testing happens against a real Stripe test-mode environment.

## Frontend wiring audit — most admin financial actions had no UI trigger

A systematic check of every payment-related backend route built across
this entire audit against actual frontend usage (`grep` for real
`authFetch` calls, not just route existence) found that almost none of
the admin-side money-moving actions had any UI caller at all — the
routes were real and correct, but unreachable except via a direct API
call. This is a different kind of gap than anything the audit itself
covered: the audit asked whether the money logic was *correct*, not
whether a human could actually *trigger* it.

**Confirmed wired**: subscription checkout (`worker-subscription`),
Billing Portal (`billing-portal`, P0-03), admin subscription stats
(`admin/subscriptions`).

**Confirmed NOT wired anywhere in the UI**: job/load payment-intent
creation and cancellation, both capture routes, the entire refund API
(P1-05), all three settlement routes (P0-05), individual worker payout,
and partner invoice generation/reporting (P0-04, P2-01).

**First piece wired, as the highest-priority one**: the admin refund
UI. Added `GET /api/admin/payment-transactions` (a lookup/search
endpoint that didn't exist — the refund route itself had nowhere to
get a transaction ID from) and a real panel in the admin dashboard:
search by job/load title, customer name, or ID; see each match's
received/refunded/remaining-refundable amounts; pick one, choose full
or partial, require a reason, and submit to the existing P1-05 refund
route. This is the first genuinely wired admin financial-action UI in
this dashboard.

**Files:** `app/api/admin/payment-transactions/route.ts` (new),
`components/DashboardApp.tsx`

**Explicitly not done**: settlement generate/approve/pay UI, payout UI,
partner invoice UI, and the customer-facing booking payment flow
(Stripe Elements card collection) all remain unwired. Each is a
separate, real piece of frontend work — not attempted in this pass
beyond the one piece specifically prioritized.

### Workstream B (partial) — worker payout visibility

Following the recommended-direction handoff's workstream split, started
with Worker Payout Visibility specifically — it's explicitly called out
as its own deliverable, reuses patterns already proven to work (the
refund console), and needs no new client-side dependency, unlike
Workstream A (Stripe Elements), which does and can't be verified in
this sandbox (no `npm install` access) the way everything else here
can be.

**Added:** `GET /api/payouts/my` — a worker's own `Payout` (moving-job
earnings) and `Settlement` (freight earnings) history, unified into one
view since both share the same `PayoutStatus` lifecycle. Wired into
both the mover and driver dashboard views via a shared
`renderPayoutHistoryPanel()` helper. Shows gross/adjustments/net,
status, and date — with an explicit note distinguishing `TRANSFERRED`
("sent to your Stripe payout balance — bank arrival depends on
Stripe's schedule") from `PAID_OUT` ("deposited to your bank"), per the
handoff's explicit requirement not to let those two look the same to a
worker.

**Also**: the mover view's "Next payout" metric now shows the real
most-recent payout when one exists, falling back to the illustrative
placeholder only when there's no real data yet — a small, genuine step
away from the P2-02 mock-data findings, not just a new addition.
Updated the disabled "Settlements" tab's tooltip to point at this real
panel instead of just the API routes, since there's now something
actually real to point at.

**Files:** `app/api/payouts/my/route.ts` (new),
`components/DashboardApp.tsx`

### Workstream B (continued) — admin capture triggers

**Added:** `GET /api/admin/captures` — the same missing-lookup pattern
as the refund console and payout history: the actual capture routes
(`jobs/[id]/capture-payment`, `loads/[id]/capture-payment`) were
already correct, there was just no way to find what's eligible.
Returns jobs at `COMPLETED`/`AUTHORIZED` and freight loads at
`POD_UPLOADED`/`AUTHORIZED` — i.e., genuinely ready to capture, not
just "exists."

**Wired a real admin panel**: lists capture-ready jobs and loads with
their amounts and customer name, a "Capture" button per row that calls
the correct existing route for that item's type, and refreshes the
list afterward so a captured item disappears rather than staying
clickable.

**One thing checked, not assumed, while building this**: the freight
capture route calls `stripe.paymentIntents.capture(id, {})` with an
empty body — the exact shape of the original P0-02 bug for moving
jobs. Traced through why this is actually correct here rather than
flagging it reflexively: freight uses flat-rate pricing agreed at
booking time, with no equivalent "final approved hours" that could
diverge from the authorized amount the way hourly moving-job labor
can. The authorized amount **is** the final amount for freight, so an
empty-body capture is the right call, not a regression of the P0-02
fix. Confirmed rather than assumed by reading the actual pricing model
this route depends on, not by pattern-matching the code shape alone.

**Files:** `app/api/admin/captures/route.ts` (new),
`components/DashboardApp.tsx`

### Capture queue display fix — a real mismatch, caught before sign-off

An independent review of the capture UI (above) correctly identified
that the queue displayed `job.estimatedTotalCents` for moving jobs,
while the capture route actually charges a separately-computed
`finalTotalCents` derived from customer-approved actual hours — the
same two numbers that motivated the original P0-02 fix many rounds
back. An admin could see one amount in the queue and capture a
different (correct, but differently-presented) one.

**Fixed via the recommended approach — a shared server-side helper,
not a display-only patch.** Extracted `calculateJobFinalCaptureAmount()`
into `lib/capture-preview.ts`, and both the capture route and the
capture-ready queue now call this **same function**. This is what
makes the two structurally unable to drift again — not two independent
implementations that happen to agree today, but one calculation both
callers depend on.

**Also closes an edge case neither the queue nor a naive fix would
have caught**: a job can be `COMPLETED`/`AUTHORIZED` (passing the
queue's original filter) while its hours still aren't customer-approved
— which would make the capture route reject it. The shared helper
returns `ok: false` with a human-readable reason in that case, and the
queue now shows that honestly (the authorized estimate, grayed out,
with the reason, and a disabled Capture button) instead of a number
that would fail if clicked.

**Files:** `lib/capture-preview.ts` (new),
`app/api/jobs/[jobId]/capture-payment/route.ts`,
`app/api/admin/captures/route.ts`, `components/DashboardApp.tsx`

### Workstream B (continued) — admin payout trigger

**Added:** `GET /api/admin/payouts-ready` — same missing-lookup pattern
as the refund console and capture queue. Returns individual worker
`Payout`s and freight `Settlement`s at `SCHEDULED` (ready to pay) or
`FAILED` (safe to retry — both routes' existing idempotency handles
this correctly), unified into one list since both share the same
`PayoutStatus` lifecycle.

**Wired a real admin panel**: worker name, type (job payout vs. freight
settlement, with load count), amount, status (including the failure
reason when relevant), and a Pay/Retry button that calls the correct
existing route for that item's type.

**One thing checked before wiring this, not assumed**: whether a
worker who hasn't completed Stripe Connect onboarding could still show
up here and have the button do something confusing. The underlying
pay routes already reject that case correctly, but rather than let an
admin discover that only after clicking, the panel checks
`stripePayoutsEnabled` per worker and disables the button with a clear
reason up front — surfacing a condition the backend already enforced,
instead of making the admin find out through a failed request.

**Files:** `app/api/admin/payouts-ready/route.ts` (new),
`components/DashboardApp.tsx`

### Payout trigger message fix — a real recurrence of the TRANSFERRED-vs-PAID_OUT distinction

The panel's success message said "Paid {workerName}..." — but at the
moment the route returns, the transfer has only been *submitted* to
Stripe (`transferred: true`), not confirmed as arrived
(`PAID_OUT`, which only the `payout.paid` webhook reports later). This
is the exact same distinction the P1-08 work spent several rounds
getting right at the data layer — and it's worth being honest that I
introduced a UI-level recurrence of it in my own new code, rather than
present this as an unrelated new finding.

**Fixed**: message now reads "Transfer initiated for {workerName} —
{amount}. Final payout status will update after Stripe confirms
processing." Also handles a case the old generic message would have
misrepresented differently: when a payout is `fullyOffset` by a bonus-
recovery balance, nothing is actually transferred at all — the message
now says that plainly instead of implying a payment happened.

**Files:** `components/DashboardApp.tsx`

### Workstream B (final piece) — partner billing report and invoice generation UI

**Two new backend pieces needed first**, matching the pattern every
prior panel in this workstream needed: a working action route with
nowhere to find what to act on.
- `GET /api/admin/partners` — search by name, legal name, or referral
  code (no partner search endpoint existed at all).
- `GET /api/partners/[partnerId]/invoices` (added alongside the
  existing `POST` generator in the same file) — lists a partner's
  already-generated invoices with status/period/totals/Stripe invoice
  ID. The generate route alone had no way to show invoice *history*.

**The admin panel**: search for a partner → select one → see the
current-month billing report preview (via the existing, P2-01-hardened
report route), the full invoice history (status, period, totals, line
count, Stripe invoice ID, due date), and a period picker to generate a
new invoice via the existing P0-04 route — reusing the same
search/select/action/refresh shape as the refund console and payout
queue, per the explicit ask to keep these patterns consistent across
the dashboard.

**Files:** `app/api/admin/partners/route.ts` (new),
`app/api/partners/[partnerId]/invoices/route.ts` (added `GET`),
`components/DashboardApp.tsx`

### Partner billing/invoice correction — a real eligibility mismatch, confirmed and fixed

**Confirmed by direct inspection**: the billing preview route
(`GET .../billing`) filtered loads by `createdAt` with no payment
status, delivery status, or already-invoiced check at all — the exact
pre-P0-04 logic that route had before this workstream even started.
The invoice *generation* route had the correct rule (`CAPTURED` +
actually delivered + not already on another invoice, filtered by
`deliveredAt`). An admin could preview one set of loads and totals,
then generate an invoice covering a genuinely different set — the
same class of drift the shared capture-preview helper was built to
prevent, just recurring in a different pair of routes.

**Fixed the same way**: added `lib/partner-invoice-eligibility.ts`
(`findEligiblePartnerLoads()`), and both the preview and generation
routes now call this one function. Pagination on the preview route is
now done in memory over the shared result, rather than by
parametrizing the helper with `skip`/`take` — keeping the eligibility
query itself byte-for-byte identical between both callers, with no
separate pagination logic that could introduce a second subtle
difference later.

**Also fixed**: the invoice-generation UI previously treated a 502
(Stripe invoice creation failing *after* the local draft invoice and
its line snapshots were already committed) as a total failure —
thrown into the catch block, never refreshing the invoice list, with
no indication to the admin that a real draft now exists in the
database. Now detects that specific case and tells the admin plainly
that a draft was saved locally even though Stripe delivery failed,
then refreshes the list so it's visible.

**Files:** `lib/partner-invoice-eligibility.ts` (new),
`app/api/partners/[partnerId]/invoices/route.ts`,
`app/api/partners/[partnerId]/billing/route.ts`,
`components/DashboardApp.tsx`

**Workstream B is now complete**: refund console, capture queue with
shared calculation helper, worker payout history, admin payout
trigger, and partner billing/invoicing are all wired frontend →
backend → database. Workstream C (freight authorization, capture,
settlement generation/approval/payment, and reconciliation) and
Workstream A (Stripe Elements — still blocked on this sandbox's lack of
`npm install` access for verification) remain.

## End-to-end workflow review (before Workstream C)

Traced complete workflows through the actual code — not individual
routes in isolation — per the explicit request that this review verify
connections between pieces, not just the pieces themselves.

### Critical finding, fixed: customers could never actually pay for anything

**`stripe.customers.create()` existed in exactly one place in this
entire codebase** — the worker subscription route. Every reference to
`CustomerProfile.stripeCustomerId` across `job-payment-intent`,
`driver-payment-intent`, and the detention-charge route was a **read**
("No Stripe customer on file for this account" → 409) — grepped
comprehensively and confirmed there was no write path anywhere,
including the registration route, which creates a `CustomerProfile`
with `{ type: "INDIVIDUAL" }` and nothing else.

**The practical consequence**: a customer could register, post a job,
request a quote — and would then hit a dead end at the very first
payment step, permanently, through every code path in the system. Not
an edge case; the primary path for every customer who ever used the
product. This is exactly the class of break route-level review
doesn't catch: every individual route correctly handled what to do
*with* a `stripeCustomerId` and correctly rejected its absence — nobody
had built the piece that actually creates one.

**Fixed**: added `lib/ensure-stripe-customer.ts` —
`ensureStripeCustomer()` lazily creates a real Stripe customer
(idempotent, keyed on the `CustomerProfile` ID) the first time one is
needed, and persists it. Wired into all three routes that previously
just checked and failed:
`app/api/stripe/job-payment-intent/route.ts`,
`app/api/stripe/driver-payment-intent/route.ts`,
`app/api/loads/[loadId]/detention/charge/route.ts`.

### Confirmed intact by direct trace, not assumed

- **Worker assignment → payout**: `Assignment.agreedEarningsCents` is
  set server-side from `job.customerMoverRateCents` at acceptance,
  never client-supplied; the full approve → `Payout` creation →
  `pay` → webhook chain traced and holds together.
- **Freight load → settlement**: `CarrierRoute.assignedWorkerId` is
  genuinely set when a driver requests/accepts a load
  (`app/api/loads/[loadId]/request/route.ts`) — the field settlement
  generation depends on isn't orphaned.
- **Notifications**: `sendTransactionalEmail`/`sendSms` are real Resend/
  Twilio API calls, not stubs — confirmed by reading the actual
  implementation, not assumed from the function names.
- **Partner billing → invoice generation**: already fixed this session
  (shared eligibility helper).

### Remaining gap, found but not fixed in this pass: no audit-log viewing UI

`GET /api/admin/audit-logs` exists as a real route (built earlier in
this project), and every action across this entire payment audit
correctly writes an `AuditLog` entry — but nothing in the frontend ever
calls this route. Every audit trail this whole audit sequence has
built is real and correctly recorded in the database, and currently
invisible to anyone without direct database access. Not fixed here —
flagged for the same reason as the Workstream B panels: it needs the
same search/list treatment as everything else, not a quick addition
alongside a critical-bug fix.

**A fourth instance, found by a follow-up comprehensive grep, not
assumed fixed after the first three**: after fixing the three routes
above, re-ran a codebase-wide search for every remaining
`.stripeCustomerId` reference rather than treating the initial fix as
complete. Found `app/api/partners/[partnerId]/invoices/route.ts` had
the identical gap — it created a real `PartnerInvoice` database record
regardless, but silently fell back to a DRAFT-only response with no
actual Stripe billing whenever `partner.customer.stripeCustomerId` was
missing, which — given nothing anywhere ever populated that field
before this fix — would have been *every* partner invoice generated,
ever. Fixed the same way, then re-ran the same comprehensive search
again afterward and confirmed zero remaining unfixed references
anywhere in the codebase.

**Files (this section):** `lib/ensure-stripe-customer.ts` (new),
`app/api/stripe/job-payment-intent/route.ts`,
`app/api/stripe/driver-payment-intent/route.ts`,
`app/api/loads/[loadId]/detention/charge/route.ts`,
`app/api/partners/[partnerId]/invoices/route.ts`

**Test results:** none, same limitation as everywhere else in this
audit — and this finding in particular is a strong argument for why:
a real `npm test`/end-to-end Stripe test-mode run would have caught
this on the very first attempted customer checkout, rather than it
surfacing only through a deliberate cross-route trace.

### Admin audit log viewer — closes the gap the end-to-end review found

**Backend pagination fixed first**: the existing `GET
/api/admin/audit-logs` route only ever returned the first `limit`
(capped at 200) rows, with no way to see anything beyond that — not
real pagination, a hard ceiling. Rewrote it with cursor-based
pagination (the last-seen log's own `id`, paired with `createdAt desc`
ordering) — stable under concurrent writes in a way an offset
wouldn't be, since new rows being written between page requests
can't cause an offset-based page to skip or repeat entries.

**The viewer itself**: newest-first table with actor email/role,
action, entity type/ID, timestamp; filters for action, entity type,
and entity ID (applied explicitly via a button, not on every
keystroke); expandable JSON details per row; a "Load more" button
using the real cursor.

**Links from other admin panels, added where they were actually
useful**: an "Audit trail" button on both the refund console and
payout queue rows, which filters the audit panel straight to that
entity's ID — added to those two specifically because refunds and
payouts are exactly where an admin is most likely to want to trace
"what happened and who did it" without retyping an ID.

**A real bug caught before shipping, not after**: the row-plus-
expandable-details table structure needed a fragment per log entry,
and my first pass used the `<>` shorthand with the `key` prop placed
on the nested `<tr>` instead of the fragment itself — shorthand
fragments can't take props at all, so React would only ever see the
key one level too deep, generating list-key warnings and unreliable
reconciliation. Caught by checking the actual JSX structure against
React's list-key requirement rather than assuming the shorthand would
work, and fixed by importing `Fragment` explicitly and keying it
directly.

**Files:** `app/api/admin/audit-logs/route.ts`,
`components/DashboardApp.tsx`

**Test results:** none, same limitation as everywhere else in this
audit.

### Security fix — partner invoice history had no ownership check at all

**Confirmed by direct inspection**: `GET
/api/partners/[partnerId]/invoices` called `requireRole(request,
["CUSTOMER", "ADMIN"])` but discarded the result entirely — no
variable captured, no check against the requested `partnerId`
afterward. Any authenticated customer could pass **any** partner's ID
in the URL and receive that partner's full invoice history: periods,
totals, Stripe invoice IDs, due dates, payment status. A real IDOR
(insecure direct object reference), not a theoretical one — the `POST`
handler in this exact same file already did the ownership check
correctly, which is what made the asymmetry easy to spot once looked
for directly.

**Fixed exactly matching the `POST` handler's pattern**: captures the
authenticated user, loads the `PartnerOrganization` together with its
owning customer's `userId`, returns 404 if the partner doesn't exist,
403 if an authenticated `CUSTOMER` doesn't own it, and only returns
invoice history after that check passes.

**Checked whether the same mistake was repeated elsewhere**: the
billing report route (`GET .../billing`, built in the same general
timeframe) already captured `authed` and checked ownership correctly —
confirmed this was an isolated miss in one specific handler, not a
pattern across the partner-facing routes built this session.

**Files:** `app/api/partners/[partnerId]/invoices/route.ts`

**Test results:** none, same limitation as everywhere else in this
audit — and this is exactly the kind of authorization bug an
automated test suite with role-based fixtures would catch
mechanically, which is a real argument for why `npm test` needs to
happen before this goes anywhere near production, not just `tsc
--noEmit`.

## Worker compliance approval — two gaps found while verifying the flow

Asked directly whether "background check comes back positive, admin
approves it" flows correctly from that point on. Verified the
enforcement side first — it does: both `app/api/loads/[loadId]/request/
route.ts` and `app/api/jobs/[jobId]/assignments/route.ts` genuinely
check `checkOpportunityAccess()`'s result and reject with a real 403,
not just call it and ignore the outcome. That's the same class of
question ("does the route actually honor the check, not just perform
it") that's caught real bugs elsewhere in this project, and this time
it held up.

Two real gaps found while continuing to verify, both fixed:

### 1. The compliance decision itself never notified the worker

`app/api/admin/workers/[workerId]/review/route.ts` (general onboarding
approval) sends a real notification. `app/api/admin/compliance/
[workerId]/decide/route.ts` (the specific background-check compliance
decision — the thing "background check comes back positive" actually
refers to) had **zero** notification code at all. A worker's
background check could be explicitly approved, restricted, or
suspended by an admin, and they would never be told, through any
channel.

**Fixed**: added the same `queueNotification` call the onboarding route
already uses, keyed on the compliance record's own ID plus the decision
type (so a retry of the same decision doesn't double-send, but a
genuinely later decision of the same type — restricted, then
reactivated, then restricted again — still gets its own notice). Also
added a `RESTRICTED` case to `workerAccountStatusTemplate()` — the
existing template only had `APPROVED`/`REJECTED`/`SUSPENDED`/
`REACTIVATED`, and `RESTRICT` is a real, distinct decision this route
supports, not an alias for suspension.

### 2. The worker-facing status page had no visibility into this gate at all

Traced `GET /api/driver/onboarding` (what the onboarding status page
actually calls) and found it reports `worker.operationalStatus` (the
general onboarding gate) and individual credential-track fields like
`identityVerification`, but never touches `WorkerCompliance.
adminApprovalStatus` — the separate gate `checkOpportunityAccess()`
actually enforces. A worker could see 100% onboarding progress, every
individual step marked complete, and still be correctly blocked from
requesting or accepting real work by this specific gate, with no
indication anywhere in what they could see that it existed.

**Fixed** at the reporting layer specifically — queried
`WorkerCompliance` directly in the onboarding route and added
`complianceStatus`/`complianceApproved` to its response, rather than
adding a new step to `evaluateWorkerEligibility()`'s shared step list,
which is used elsewhere for job/load-specific eligibility checks and
carries real risk of changing behavior for those other callers if
touched here. Wired the new field into
`components/OnboardingStatusPage.tsx`'s status line so it's actually
visible, not just returned unused by the API.

**Files:** `app/api/admin/compliance/[workerId]/decide/route.ts`,
`lib/email/templates/documents.ts`,
`app/api/driver/onboarding/route.ts`,
`components/OnboardingStatusPage.tsx`

**Test results:** none, same limitation as everywhere else in this
audit.

## Client portal job-posting — a foundational gap, deeper than previously known

Asked directly to verify the client (customer) portal's job-posting
flow works correctly. Checked the frontend form first, since it had
been explicitly labeled preview-only during an earlier pass — confirmed
it was still exactly that: the "Authorize with Stripe" button remained
disabled, and the underlying form fields (project type, address,
description) were entirely uncontrolled inputs with no state binding
at all, meaning even connecting a submit handler to the form as it
stood wouldn't have had real data to send.

**A bigger, previously undiscovered gap surfaced while checking
further**: `POST /api/jobs` has always required an existing
`addressId` — it never accepted raw address text. Searched
comprehensively and found **nothing anywhere in this codebase, backend
or frontend, ever created an `Address` record for a customer**. This
meant job creation could never have succeeded for any customer through
any path, entirely independent of the already-known Stripe Elements
gap — the same class of "hard requirement with zero code path that
satisfies it" as the `stripeCustomerId` finding from the end-to-end
review two rounds back.

**Fixed**: added `POST`/`GET /api/addresses` (create and list a
customer's saved addresses — deliberately does not geocode itself,
since `POST /api/jobs` already geocodes lazily if an address lacks
coordinates, so this stays a fast, simple save rather than duplicating
that logic).

**Then actually wired the form**, not just the missing backend piece:
every field is now bound to real state (project type, structured
address fields — street/city/state/ZIP, matching what the backend
actually needs, not a single free-text blob — and project details),
and a `startsAt` date/time field was added entirely, since the backend
requires it and the form never had one at all. `handlePostJob()` now
creates the address, then the job, and reports the real
`estimatedTotalCents` back.

**What's still honestly not done**: the "Post job" button creates a
real job — verified against the actual `POST /api/jobs` response shape
(`{ job, quote }`, no restrictive `select` on the create call) rather
than assumed — but payment authorization (Stripe Elements card
collection) remains exactly the separately-tracked, larger piece of
work it always was. The success message says so explicitly rather than
implying the booking is complete.

**Confirmed correct without needing a fix**: `GET /api/jobs` already
gives a customer their own jobs at full detail (not the mover-facing
sanitized view) — both by reading the code and by its own comment
("they own this data"). Worth stating plainly since not everything
found during this check was a gap; this piece already worked.

**Files:** `app/api/addresses/route.ts` (new),
`components/DashboardApp.tsx`

**Test results:** none, same limitation as everywhere else in this
audit — and, as with the customer Stripe-ID gap, this is exactly the
kind of break a single real end-to-end signup-to-booking test run
would have caught on the first attempt, rather than requiring a
targeted trace to surface.

## Two corrections to the compliance-notification fix

### 1. Duplicate `const statusMap` declaration — a real compile error this project's syntax-only checks didn't catch

The compliance decide route had **two separate `const statusMap`
declarations in the same function scope** — one mapping decisions to
the database's `adminApprovalStatus` value, added when the route was
first built; a second, added later for the notification template's
status value, reusing the same name. This is a genuine error under a
real `tsc` compile ("Cannot redeclare block-scoped variable"), not a
style nit — and it's a second, independent instance of the same blind
spot flagged earlier in this audit (`transpileModule`'s single-file,
syntax-only checking has no scope/semantic analysis, so it silently
accepted this).

**Fixed**: renamed the notification-purpose map to
`notificationStatusMap`. The two maps couldn't simply be merged into
one — they intentionally return different values for `REACTIVATE`
(`"APPROVED"` for the database enum, `"REACTIVATED"` for the
notification copy), so this was a real naming collision between two
legitimately different mappings, not a redundant duplicate to delete.

**Given this exact class of bug had now appeared twice**, wrote a
proper block-scope-aware duplicate-declaration scanner (using the
TypeScript compiler's real AST, not a regex) and ran it across every
file in `app/`, `lib/`, and `components/` — 138 files. Found zero other
genuine same-block duplicates. (An earlier, cruder version of this
scanner initially flagged 33 "duplicates" that turned out to be false
positives from not respecting that each `if`/`for`/`catch` block gets
its own scope — corrected before trusting the result.)

### 2. Compliance notification idempotency key could collide across genuinely different decisions

The key was `` `compliance-status:${compliance.id}:${decision}` ``. But
`compliance.id` is the same **upserted** `WorkerCompliance` row across
a worker's entire history — it never changes. A worker restricted,
later reactivated, then restricted *again* for an unrelated later
reason would produce the identical key both times (same
`compliance.id`, same `"RESTRICT"` decision), and the second
notification would be silently treated as a duplicate of the first and
never sent.

**Fixed**: keyed off the audit log entry's own ID instead — `` `compliance-status:${audit.id}` `` — matching the pattern the sibling
onboarding-review route already used correctly for exactly this
reason. Each decision now gets a genuinely unique key, while a retry of
the *same* decision (e.g. a duplicate request) still correctly reuses
it, since the same audit log row wouldn't be created twice.

**Files:** `app/api/admin/compliance/[workerId]/decide/route.ts`

**Test results:** none, same limitation as everywhere else in this
audit. Both corrections applied; per the requested sequence, the next
step is the actual executable validation gate (`npm ci`, `npx prisma
generate`, `npx tsc --noEmit`, `npm run lint`, `npm test`, `npm run
build`) and Stripe/Checkr test-mode scenarios — none of which this
sandbox can run, and which remain the real gate before any of this is
production-verified.

## Freight load-posting form — built, plus one gap found while verifying the full path

### The form

`POST /api/loads` had zero frontend caller — not even a disabled
placeholder, unlike moving-job posting. Its schema
(`lib/loads/post-load-schema.ts`) is architecturally different from
job posting, worth being explicit about rather than assuming
consistency: it takes **raw address fields directly**
(`originCity`/`originState`/`originZip`, `exactPickupAddress` as free
text) and was never built around the `Address` model the way moving
jobs are — so `POST /api/addresses` genuinely doesn't apply here, and
building the form around a nonexistent `addressId` requirement would
have been wrong, not more thorough.

Built a complete panel in the customer view with real controlled state
for every backend-supported field: service type (a real selector
across all three discriminated-union branches — owner-operator box
truck flat rate, owner-operator semi flat rate, driver-only hourly —
each showing only the pricing field that branch actually accepts, matching
the backend's own enforcement that an hourly rate can never be
submitted alongside a flat payout), origin/destination, pickup
date/time, estimated hours or miles, stop count, liftgate/CDL
checkboxes, local-route flag, and the private fields (exact addresses,
shipper contact, commodity description) — all clearly labeled "private
— never shown pre-assignment" in the form itself, not just in code
comments. Returns the real created load ID and the real calculated
`totalCents` from the actual API response. States plainly that payment
authorization is still pending Stripe Elements, exactly as done for
job posting.

### Verifying the full path — one gap found, not fixed here

Traced create → sanitized driver board → request/accept → assignment →
"full assigned details" as asked. The first three legs hold up:
`PUBLIC_LOAD_SELECT` is confirmed still just an alias for
`SANITIZED_LOAD_SELECT` (untouched by this change), and the request/
accept route atomically claims the load with a real concurrency guard
(a losing concurrent driver gets a clean 409, not a silently
overwritten assignment).

**The last leg has a real, if narrow, gap**: the request route *does*
correctly return full details (exact addresses, shipper contact,
access code, commodity description) — but only once, as the immediate
response to a successful assignment. There is no durable "view this
load again" path: `GET /api/driver/loads` always applies
`SANITIZED_LOAD_SELECT`, with no branch for "this load is assigned to
me, show the full record." A driver who navigates away and comes back
would no longer be able to see the address they need to actually
complete the delivery, through any route in this codebase.

**Not fixed in this pass** — flagged rather than silently expanded
into, given the amount of new surface already added this round.
Fixing it correctly would mean adding a conditional branch to `GET
/api/driver/loads` (or a dedicated detail route) that checks
`assignedWorkerId === requesting driver` and returns the full field
set only in that case — the same shape of fix
`lib/access/opportunity-access.ts`'s `VIEW_ASSIGNED_DETAILS` action
already anticipates, just not yet wired to an actual data-returning
route for loads specifically.

**Files:** `components/DashboardApp.tsx`

**Test results:** none, same limitation as everywhere else in this
audit. The duplicate-declaration scanner (built two rounds ago after
finding a real instance) was re-run across the entire codebase after
this change — 152 files, zero genuine same-block duplicates.

## Service intent preserved from homepage through to the dashboard

Previously every service button on the marketing homepage (Post a Job,
Book Moving Labor, Get Box Truck Delivery, Post a Freight Load /
Request Freight Quotes) produced the identical generic `{ mode:
"register", role: "CUSTOMER" }` intent — a customer who specifically
asked for freight landed on the same view as one who wanted hourly
movers, with no distinction.

**The full chain, widened end to end** (`AuthIntent` now carries an
optional `service: "moving-labor" | "box-truck-delivery" | "freight"`):
`TempMoversHero.tsx`'s buttons and its quote-tab submit now pass the
matching service value → `MarketingHomepage.tsx`'s own copy of the type
widened to match (required since it forwards `onGetStarted` through
unchanged, and a narrower local type would have mismatched the wider
one it's passed to) → `AuthGate.tsx` stores it in `authIntent` state
exactly as it already did for `mode`/`role`, and now also passes it
through the `children(user, service)` render-prop on successful auth →
`app/page.tsx` forwards it into `DashboardApp` as `initialService`.

**What `DashboardApp` does with it**: a `useEffect` fires once on
arrival at the customer view — `moving-labor` scrolls to the job-
posting panel; `box-truck-delivery` and `freight` both scroll to the
freight panel, with `box-truck-delivery` additionally pre-selecting
the `OWNER_OPERATOR_BOX_TRUCK` service-type branch, since that specific
mapping is unambiguous. Generic `freight` intentionally leaves the
service-type selector at its own default rather than guessing between
the semi and driver-only branches — a customer who just said "freight"
didn't specify which.

**Judgment calls made explicit, not left implicit**: `MarketingHomepage.tsx`'s
own "Try the job assistant" / "Or book directly" buttons deliberately
carry no service — that section's entire premise is "not sure what you
need," so leaving it unset is the accurate choice, not a gap. Its "Set
up a business account" button also carries none, since that's about
partner-account setup, not booking one specific service. Neither
"Become a Mover" nor "Drive With TempMovers" needed any change — `role`
alone already determines their destination.

**Files:** `components/marketing/TempMoversHero.tsx`,
`components/marketing/MarketingHomepage.tsx`, `components/AuthGate.tsx`,
`app/page.tsx`, `components/DashboardApp.tsx`

**Test results:** none, same limitation as everywhere else in this
audit.

## Assigned-load details — the durable-visibility gap, fixed

### Why this needed a new route, not a branch in the existing one

`GET /api/driver/loads` filters to `status: { in: ["OPEN",
"OFFER_RECEIVED"] }` — a load moves to `ASSIGNED` the moment it's
claimed and drops off that list entirely. That route's whole shape
(visibility rules, market filtering, that status filter) is about
browsing open opportunities, not tracking a driver's own committed
work. Folding "and also show my assigned loads" into it would have
meant either weakening its filters or adding a parallel code path
inside the same function — both riskier than a small dedicated route
with its own simple `assignedWorkerId` filter.

### A second issue found while building the fix, not assumed

Before writing the new endpoint, checked exactly what
`POST /api/loads/[loadId]/request` already returns at the moment of
assignment, to keep the two consistent. Found its response was
**itself already incomplete** — a hand-picked field list (`id`,
`status`, city/state, plus the six private fields) missing `title`,
`pickupDate`, `equipmentType`, `estimatedHoursOrMiles`, and
`grossCarrierCents` — meaning a driver didn't even see the payout
amount or pickup time in the response the instant they were assigned a
load.

### The fix

Added `FULL_ASSIGNED_LOAD_SELECT` to `lib/access/sanitize-load.ts`
(spreading the existing `SANITIZED_LOAD_SELECT` plus the six private
fields) — one canonical select, mirroring how `SANITIZED_LOAD_SELECT`
itself was extracted to keep the public and authenticated board
listings from drifting. Both the request route and the new endpoint
now use this same constant, so they can't diverge again.

`GET /api/driver/assigned-loads` (new): a driver's own assigned loads,
filtered simply by `assignedWorkerId`, full detail, no market/
visibility filtering needed since assignment itself is the
authorization.

**Frontend**: a new panel in the driver view — assigned loads listed
with route/pickup/payout at a glance, an expandable "Full details" row
per load showing the exact addresses, shipper contact, access code,
and commodity description. Uses the same `Fragment`-with-explicit-key
pattern established after the audit-log-viewer bug two rounds back,
not the `<>` shorthand that caused that issue.

**Files:** `lib/access/sanitize-load.ts`,
`app/api/loads/[loadId]/request/route.ts` (now uses the canonical
select instead of its own incomplete one),
`app/api/driver/assigned-loads/route.ts` (new),
`components/DashboardApp.tsx`

**Test results:** none, same limitation as everywhere else in this
audit. Duplicate-declaration scanner re-run across the full codebase
after this change — 153 files, zero genuine same-block duplicates.

### Follow-up: made the status filter a deliberate, documented choice

Checked the actual `LoadStatus` enum before deciding rather than assume
it matched a generic example — `OPEN, OFFER_RECEIVED, ASSIGNED,
IN_TRANSIT, DELIVERED, POD_UPLOADED, SETTLED, CANCELED`. No `ARCHIVED`
status exists in this schema at all.

**The decision**: excludes `CANCELED` specifically, keeps everything
else. A canceled assignment is void — the driver has no further
obligation on it, so there's no ongoing legitimate need for them to
keep seeing a shipper's exact address and contact info for a load that
never happened; narrowing that visibility by default is the more
conservative posture. `DELIVERED`/`POD_UPLOADED`/`SETTLED` are
deliberately **kept** — those represent actual completed work a driver
may need to reference later (a proof-of-delivery dispute, earnings
reconciliation, a commodity-related claim). So this endpoint is "my
active and completed assignments," not "my currently active ones
only" — a real distinction, made explicitly rather than left for
someone to guess at later.

**Files:** `app/api/driver/assigned-loads/route.ts`

## Freight settlement operations UI — built, with a process note worth being direct about

### What's new

`GET /api/settlements` (list, new — the same missing-lookup shape as
every other admin panel this engagement) and `GET /api/admin/drivers`
(search, new — generation needs a `workerId` and nothing could find
one). A complete admin panel: search a driver → pick a period →
generate; a filterable list of existing settlements with Approve/Pay
actions per row, correctly disabled with a reason when a driver hasn't
completed Stripe Connect onboarding, mirroring the same check already
built into the individual worker-payout panel.

### A process failure worth stating plainly, not glossing over

Building the `GET` handler for `/api/settlements` meant touching the
same file as the existing `POST` (generation) handler. Instead of
viewing the file first and adding only the new handler, I rewrote the
whole file from memory of what the generation logic should do. That
was a mistake, and it produced four real, distinct errors before I
caught them by cross-checking against this README's own documentation
of the original implementation and the actual Prisma schema:

1. **A weakened concurrency guard** — my rewrite's claim only checked
   `id in [...] AND settlementId: null`. The original repeated the
   *full* eligibility predicate at claim time, which guards against a
   different failure mode: eligibility drift between the read and the
   claim (e.g. a concurrent refund changing a load's `paymentStatus`
   away from `CAPTURED` in the gap between when it was read as
   eligible and when this transaction tries to claim it), not just two
   settlement-generation requests racing each other.
2. **A missing required field** — `SettlementDetentionLine.loadId` is
   required; my `createMany` call omitted it entirely, which would
   have failed at runtime against the real schema.
3. **A wrong field name and a nonexistent enum value** — used
   `status: "PAID"` when the actual field is `paymentStatus` and the
   correct value is `CAPTURED`; there is no `"PAID"` value anywhere in
   `PaymentStatus`.
4. **A silently dropped audit trail** — `authed` was never captured
   from `requireRole()`, so the `SETTLEMENT_CREATED` audit entry had no
   `actorId` at all.

All four are fixed, each verified individually against the actual
schema rather than assumed correct afterward — `grep`ping the real
`LoadStatus`, `PaymentStatus`, and `SettlementDetentionLine` field
definitions rather than trusting memory a second time. Also cleaned up
a sloppy `status as never` type-cast in the `GET` handler, replacing it
with real Zod validation against the actual `PayoutStatus` enum.

**The lesson, stated for whoever reads this next**: the "read before
writing, don't rewrite from memory" discipline that's been named
explicitly elsewhere in this document isn't a formality — this section
is what happens when it's skipped even once, on a route with genuine
financial concurrency-safety logic in it. Every other route touched
this engagement was edited with `str_replace` against a freshly-viewed
file; this one should have been too.

**Also fixed while wiring the frontend**: my initial handler assumed
the settlement `pay` route returns a `fullyOffset` field, copying that
shape from the individual worker-payout route without checking whether
settlements share it. They don't — checked the actual route and found
its real success shape is `{ settlement, transferred, reconciled? }`.
Fixed before shipping, not left as a dead code path implying a feature
that doesn't exist.

**Files:** `app/api/settlements/route.ts` (GET added, POST corrected),
`app/api/admin/drivers/route.ts` (new), `components/DashboardApp.tsx`

**Test results:** none, same limitation as everywhere else in this
audit — and given what this section just described, that gate matters
more here than almost anywhere else in this codebase. Duplicate-
declaration scanner re-run across the full codebase — 154 files, zero
genuine same-block duplicates.

### Date-boundary fix: inclusive UI dates vs. exclusive backend range

**Confirmed by direct inspection**: `<input type="date">` naturally
reads as inclusive to an admin ("through Jan 31" means all of Jan 31
counts), but was being sent as `new Date(dateValue).toISOString()` —
midnight UTC at the *start* of that date. The backend's eligibility
filter (`deliveredAt: { gte: periodStart, lt: periodEnd }`) treats
`periodEnd` as exclusive, so a settlement generated "through Jan 31"
would silently exclude everything actually delivered on Jan 31 itself.

**Fixed** with a `toExclusiveEndDate()` helper that converts the
selected end date into midnight UTC of the *following* day — the fix
belongs at this UI boundary, not the backend's `gte`/`lt` rule itself,
since adjacent settlement periods correctly not overlapping is the
right database pattern to keep.

**Checked for the same pattern elsewhere rather than treating this as
settlement-specific**: partner invoice generation has an identical
period-picker shape, and `findEligiblePartnerLoads()` uses the exact
same `deliveredAt: { gte, lt }` filter — confirmed it had the
identical bug and fixed it with the same helper, rather than leaving a
second, undiscovered instance of the same class of issue live in a
sibling feature.

**Also checked and confirmed clean**: the partner billing *report
preview* has no UI date-picker at all — it calls the backend with no
query params and relies on the backend's own current-month default,
so there was no UI-supplied date to get wrong there.

**Files:** `components/DashboardApp.tsx`

**Test results:** none, same limitation as everywhere else in this
audit. Duplicate-declaration scanner re-run — 154 files, zero genuine
same-block duplicates.

## Workstream A — Stripe Elements built, with the verification limitation stated as clearly as possible

### The architectural choice, and why

A real Stripe Elements integration normally means installing
`@stripe/stripe-js` (and often `@stripe/react-stripe-js`) via npm. This
sandbox has no `npm install` access — that's been the stated reason
Workstream A was deferred every time it came up. Rather than leave it
unbuilt indefinitely, built it against Stripe.js loaded directly from
Stripe's own CDN (`https://js.stripe.com/v3/`) — a real, Stripe-
documented alternative to the npm package, not a workaround invented
for this constraint. This is the one path that let this actually be
written and reasoned about here, instead of staying a placeholder.

**The honest tradeoff**: no official TypeScript types exist without
the npm package, so `lib/stripe-client.ts` hand-writes minimal types
for only the exact subset of the Stripe.js surface used
(`elements()`, `create("payment")`, `confirmPayment()`). These are
written from documentation and training knowledge, not verified
against the real current API surface.

### What's built

- `lib/stripe-client.ts` — idempotent CDN script loader, rejects
  clearly if `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` isn't configured
  rather than failing silently inside Stripe.js.
- `components/StripePaymentForm.tsx` — the full flow: create the
  PaymentIntent via the existing, already-correct
  `job-payment-intent`/`driver-payment-intent` routes → load Stripe.js
  → mount a PaymentElement → confirm with `redirect: "if_required"`
  (keeps this a single-page flow unless the card issuer's 3D Secure
  step genuinely requires leaving the page, which Stripe handles on
  its own side) → explicit states for every outcome (idle, preparing,
  ready, confirming, succeeded, requires additional action, error) —
  `requires_action` is handled explicitly rather than silently folded
  into "succeeded," even though it should be rare with `if_required`.
- Wired into both the job-posting and freight-posting panels in
  `DashboardApp.tsx`, replacing the "preview only" / "isn't wired yet"
  notices that existed after this session's earlier work — a posted
  job or load now shows a real authorization form immediately,
  tracking the actual returned amount rather than a stale estimate.

### What is genuinely NOT verified, stated once here rather than hedged at every line

This component has never executed in a real browser, against a real
network, or against a real Stripe account. Syntax-checked, and its
logic is traced against the real backend response shapes (`clientSecret`,
`paymentIntentId`, `totalCents` — read directly from the actual route
files, not assumed) — but whether the CDN script actually loads in this
app's runtime, whether the PaymentElement actually mounts into the DOM
correctly, and whether a real test-mode card actually confirms
end-to-end all remain open until this runs in a real environment.

**Before this touches production**, beyond the general `npm ci`/`tsc`/
`test`/`build` gate already outstanding for the whole project:
- Load the app in an actual browser with real `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`
  test-mode credentials and confirm the script loads and the element mounts.
- Run an actual test-mode card through the full flow, including a
  3D-Secure-triggering test card specifically, to confirm the
  `requires_action`/redirect handling behaves as written.
- If a Content-Security-Policy is ever added to this app (none exists
  today — checked `next.config.ts` directly, nothing there currently
  blocks this), it will need `https://js.stripe.com` allowed for
  `script-src` and Stripe's frame/connect origins allowed for
  `frame-src`/`connect-src`, or this integration will silently stop
  working the moment a CSP is introduced.

**Files:** `lib/stripe-client.ts` (new),
`components/StripePaymentForm.tsx` (new),
`components/DashboardApp.tsx`

**Test results:** none — and unlike every other "test results: none"
note elsewhere in this document, this one carries a materially higher
bar to clear before production, since it involves third-party
JavaScript loaded at runtime rather than only this codebase's own
logic.

## Tipping — a complete new feature, built end to end

Implemented per an explicit spec: tips only after successful
completion, 100% to workers with no platform fee, a separate `Tip`/
`TipAllocation` table pair rather than a field on `PaymentTransaction`,
support for both moving crews and freight drivers, and tip history in
both worker dashboards and admin reporting.

### Schema

`Tip` (the customer's payment — linked to a job or load, never both,
matching the existing `PaymentAttempt`/`PaymentTransaction` pattern)
and `TipAllocation` (one row per worker's share). `TipAllocation`
reuses `PayoutStatus` rather than inventing a new enum — transferring a
tip share to a worker is mechanically the same operation as any other
payout. Deliberately **not** created at tip-creation time — only once
the parent `Tip`'s payment actually succeeds, via the webhook, so there
is no such thing as a payable allocation for a tip that hasn't been
collected yet.

### Split logic

`lib/tip-split.ts` — one canonical function for jobs (even split across
every `APPROVED` assignment, the same workers who were actually paid
for the labor; integer-division remainder goes to the first worker
rather than being lost) and one for freight (the single assigned
driver). Eligibility mirrors capture eligibility (completed/delivered +
`CAPTURED`), checked both before charging the customer and again when
the payment succeeds, so a customer is never charged for a tip that
turns out to have nowhere valid to go.

### Payment flow

`POST /api/jobs/[jobId]/tip` and `POST /api/loads/[loadId]/tip` charge
immediately (no manual-capture step — a tip has no "final amount"
ambiguity to hold open) and return a client secret for the existing
`TipForm.tsx` (Stripe Elements, same CDN-loading approach as
`StripePaymentForm.tsx`) to confirm.

### Webhook handling — added as a fully separate block, deliberately

The generic `payment_intent.succeeded`/`payment_intent.payment_failed`
handlers were confirmed safe for tip events before writing anything —
their job/load/`PaymentAttempt` `updateMany` calls match on IDs a tip's
PaymentIntent will never have, and the receipt-generation function
already no-ops when neither a job nor a load matches. Rather than rely
on that implicit safe no-op, tip handling was added as its own
explicit block — clearer for a future reader, and avoids a wasted
Stripe API call the receipt function would otherwise make before
discovering it has nothing to do. **Caught and fixed a genuinely bad
piece of code before it shipped**: the first draft computed the
per-worker split with a nested ternary that called
`computeLoadTipRecipient` twice for the same result — replaced with
plain if/else before moving on, since compactness isn't worth that
kind of subtle-bug risk in code moving real money.

### Admin payout

`POST /api/admin/tip-allocations/[allocationId]/pay` mirrors the
settlement pay route's pattern precisely, including *why* it has no
separate operation-ledger table: like a settlement, a tip allocation
has no bonus-recovery concept, so its own `idempotencyKey` field
doubles as both the atomic claim marker and the Stripe idempotency key.
Same TRANSFERRED-vs-PAID_OUT distinction preserved throughout,
including in the admin UI's own success message.

### A real gap found and closed along the way, not scope creep

Building the customer-facing "leave a tip" UI required somewhere to
trigger it from — and there was no way for a customer to see their own
past jobs or loads at all after posting them. `GET /api/jobs` already
had a correct customer branch to reuse for jobs; **no load equivalent
existed at all**, so `GET /api/loads/mine` was built. This is
independently useful beyond tipping — it's the first time a customer
could see their own posted freight loads after creating them.

### Frontend

- `components/TipForm.tsx` — a separate component from
  `StripePaymentForm.tsx` rather than a generalized version of it,
  since the surrounding UX genuinely differs (quick-pick amounts and
  free entry, no pre-computed total).
- Customer "My Jobs & Loads" panel — the tip-eligibility check and
  entry point, showing a "Leave a tip" action only for
  completed/delivered and captured items.
- Worker tip history — `renderTipHistoryPanel()`, wired into both the
  mover and driver views, following the exact rendering pattern
  `renderPayoutHistoryPanel()` already established.
- Admin tip reporting — every tip with its allocations, a Pay/Retry
  action per allocation, Stripe Connect onboarding correctly checked
  before enabling the button (same pattern as every other payout
  action in this dashboard).

**Files:** `prisma/schema.prisma`, `lib/tip-split.ts` (new),
`lib/email/templates/payments.ts` (added `tipReceivedTemplate`),
`app/api/jobs/[jobId]/tip/route.ts` (new),
`app/api/loads/[loadId]/tip/route.ts` (new),
`app/api/stripe/webhook/route.ts`,
`app/api/admin/tip-allocations/[allocationId]/pay/route.ts` (new),
`app/api/tips/my/route.ts` (new), `app/api/admin/tips/route.ts` (new),
`app/api/loads/mine/route.ts` (new), `components/TipForm.tsx` (new),
`components/DashboardApp.tsx`

**Test results:** none, same limitation as everywhere else in this
audit — and the same Workstream A verification caveat applies to
`TipForm.tsx` specifically (untested against a real Stripe account),
while everything else in this feature (the schema, the split logic,
the webhook handling, the admin payout route) has been reasoned
through and syntax-checked with the same rigor as the rest of this
codebase. Duplicate-declaration scanner re-run across the complete
codebase after this feature — 164 files, zero genuine same-block
duplicates.

## Tipping fix + customer Approve Hours / Dispute — per developer handoff

### 1. A real financial-integrity bug in the tipping feature, confirmed and fixed

A review correctly identified that `Tip.status` was set to `SUCCEEDED`
**before** allocation was even attempted. If the split computation
failed, or the allocation transaction failed partway through, the tip
was left marked done while the customer's money had been captured and
no worker had actually received anything.

**Fixed**: added `TipStatus.PAID_UNALLOCATED` — payment captured,
allocation not yet completed, distinct from `FAILED` (which would
incorrectly suggest the charge itself didn't go through and could
prompt a customer to retry, double-charging them). Built
`attemptTipAllocation()` in `lib/tip-split.ts` — computes the split,
then creates every `TipAllocation` and marks the `Tip` `SUCCEEDED`
inside one transaction, so either both happen or neither does.
Notifications moved outside the transaction entirely, reading back
what was actually created afterward — an external side effect has no
business inside a database transaction that might still roll back.

**Recovery path**: `POST /api/admin/tips/[tipId]/retry-allocation`
calls the exact same shared function the webhook itself uses, so a
manual retry and the original automatic attempt can never behave
differently. Wired into the admin tip reporting panel as a "Retry
allocation" button, shown specifically for `PAID_UNALLOCATED` tips.

**A mistake I made and caught while doing this refactor, stated
plainly**: extracting the shared function accidentally deleted
`computeLoadTipRecipient` entirely in one edit. Caught immediately by
the very next syntax check (which failed on the now-missing function)
rather than going unnoticed — restored before moving on. Worth
mentioning specifically because it's a reminder that even careful
refactoring of just-written code needs the same verification step as
everything else, not an exemption because it's fresh.

**Files:** `prisma/schema.prisma`, `lib/tip-split.ts`,
`app/api/stripe/webhook/route.ts`,
`app/api/admin/tips/[tipId]/retry-allocation/route.ts` (new),
`components/DashboardApp.tsx`

### 2. Customer Approve Hours / Dispute UI — the other confirmed gap, now closed

Confirmed exactly as flagged: `POST /api/assignments/[assignmentId]/approve`
already existed, already correctly created the worker's `Payout` and
advanced the job to `COMPLETED` once every assignment was approved —
but nothing in the frontend ever called it. A worker could check out
and a job would sit at `CHECKED_OUT` indefinitely, with no way for a
customer to ever move it toward capture.

**Backend additions**:
- `GET /api/jobs/[jobId]/assignments` — added purely additively to the
  existing assignments route file, without touching the existing
  `POST` handler at all. Lists a job's checked-out/approved
  assignments for the customer to review.
- `disputedAt`/`disputeReason` added to `Assignment`, and
  `POST /api/assignments/[assignmentId]/dispute` — completes the
  Approve/Dispute pair. Deliberately does **not** invent a new status:
  a disputed assignment simply stays at `CHECKED_OUT`, which already
  structurally blocks payout creation and job completion through the
  exact same mechanism that already blocks an unapproved one. No new
  enforcement had to be added anywhere else in the system for a
  dispute to actually block billing. Alerts an admin for manual
  review — no automated resolution path exists, or should: an hours
  dispute needs a human to look at what actually happened.

**Frontend**: a real "Approve hours" button per job in the customer's
"My Jobs & Loads" panel (shown for any job not yet `COMPLETED` or
`CANCELED`), expanding to show each worker's scheduled vs. actual
hours with working Approve and Dispute actions, refreshing both the
per-job assignment list and the overall jobs list after either action.

**Files:** `prisma/schema.prisma`,
`app/api/jobs/[jobId]/assignments/route.ts` (added `GET`),
`app/api/assignments/[assignmentId]/dispute/route.ts` (new),
`components/DashboardApp.tsx`

### 3. Manual capture retained, as recommended

No change to the capture flow — it remains a separate, admin-triggered
action via the existing capture queue. Automatic capture after final
approval was explicitly not built this round, per the recommendation
to keep the operational safety net while the marketplace is new and
revisit this as a configurable admin setting after production
experience.

### On the Prisma migration

This sandbox cannot run `npx prisma migrate` — no `npm install` access
means no working Prisma CLI. The schema changes in this round
(`TipStatus.PAID_UNALLOCATED`, `Assignment.disputedAt`/`disputeReason`)
are validated the same way every schema change in this engagement has
been — brace-balanced, no duplicate fields — but **no actual migration
file has been generated or applied anywhere**. Generating and
committing the real migration (`npx prisma migrate dev --name
tip_allocation_and_dispute_fields` or equivalent) needs to happen in an
environment with a working Prisma CLI before any of this reaches a
real database.

**Test results:** none, same limitation as everywhere else in this
audit. Full regression and duplicate-declaration scanner re-run across
the complete codebase after this round — 166 files, zero genuine
same-block duplicates; 159 files, all clean.

## Load board verification — a real bug found and fixed, plus a genuine feature gap identified

### The bug: a signed-in driver could never actually request a load

`<LoadBoard />` was mounted in the driver dashboard with **no
`authToken` prop at all**. `DashboardApp` only ever renders after
`AuthGate` confirms sign-in, so this section is always inside an
authenticated session — but `LoadBoard.tsx` takes its token as an
explicit prop rather than reading it from storage itself (a deliberate
design, since this same component is meant to also work in
unauthenticated/public contexts). With no token passed, it silently
operated in signed-out mode: fetching the public board instead of the
authenticated one, and "Request this load" always showing "Sign in as
a driver," even to an already-signed-in driver looking at their own
dashboard.

**Fixed**: `<LoadBoard authToken={getAuthToken() ?? undefined} />`.

**Everything downstream of that, re-verified and confirmed intact**:
`POST /api/loads/[loadId]/request` — visibility-tier gating
(`PUBLIC_PREVIEW`/`VERIFIED_CARRIERS_ONLY`/`PREFERRED_NETWORK`/
`PRIVATE_CONFIDENTIAL`), market/eligibility checks, and the atomic
claim (a losing concurrent driver gets a clean 409, not a silently
overwritten assignment) are all correct and unaffected by this fix —
the request route itself was never the problem; nothing could reach it
with real credentials.

**Files:** `components/DashboardApp.tsx`

### The genuine gap: businesses/consumers cannot choose a specific worker

Checked this directly rather than assumed. **The schema and
enforcement for a freight "preferred network" already exist and work
correctly** — `PreferredWorker` (partner ↔ worker, with a priority),
and `CarrierRoute.visibility = "PREFERRED_NETWORK"` is genuinely
gated in the request route (a worker not on the list gets rejected).
But `PreferredWorker` is only ever **read**, in exactly two places —
nothing anywhere creates one. A business has no way to actually build
a preferred network in the first place, so this gate currently has no
way to ever be populated with real recipients.

**Moving jobs have no equivalent mechanism at all.** `AssignmentStatus`
includes `INVITED` in the enum, but it's never written by any route —
job assignment is entirely open-pool (any eligible mover self-selects
by applying), with no invitation path. There is also no customer- or
business-facing endpoint anywhere that lists workers to browse — every
`workerProfile.findMany` call outside of `app/api/admin/` is one of
this session's own admin-search endpoints (drivers, for settlement
generation), not anything a customer could reach.

**Not built this round** — this is a real, sizable new feature
(browsing worker profiles, an invite-a-specific-worker flow for jobs,
and an actual "add to preferred network" management UI for partners),
not a bug fix, and building it without confirming scope first risked
guessing wrong about what "choose your helper" should actually look
like. Flagged clearly rather than either ignored or built on
assumption.

**Test results:** none, same limitation as everywhere else in this
audit. Full regression and duplicate-declaration scanner re-run after
the LoadBoard fix — 166 files / 159 files, both clean.










All 8 P1 + 4 P2 findings from the payment audit remain. The audit's own
**NO-GO** verdict for unsupervised production payments stands until
those are addressed — all five P0 items are now closed, but P0 alone
was never the full bar for production-readiness per the audit's own
Definition of Done.



Two related but distinct problems surfaced across this and the standalone
test-mode artifact, and it's worth being precise about which fix applied
where.

**The real backend (`components/marketing/TempMoversHero.tsx` +
`.module.css`) never had the base64/layering bugs** described in one
handoff — it was already using `next/image` with a real file path and a
dedicated `.backdrop` div from when it was first built. What it **did**
have, confirmed by direct inspection, was the exact same overlay bug
found (empirically, via headless-browser pixel sampling) in the
standalone artifact: a `@media(max-width:1080px)` rule that replaced the
intended subtle left-to-right gradient with a flat, nearly-opaque
`rgba(255,255,255,.88)` wash — meaning the backdrop photo was almost
entirely hidden on every tablet and mobile viewport, regardless of
whether the image itself loaded correctly.

Fixed to match the exact production recommendation: switched
`.backdrop`/`.backdropOverlay` from negative z-index (`-3`/`-2`, which
depends on `isolation: isolate` behaving a specific way with the parent
stacking context) to plain positive z-index (`0`/`1`/`2` for
backdrop/overlay/content) — a more robust, less context-dependent
pattern — and reduced both the base gradient and both media-query
overrides to meaningfully lower opacity so the skyline stays visible at
every breakpoint instead of just the widest one.

Verified directly against the actual files rather than assumed: the
market config's `heroBackdrop` path resolves to a file that genuinely
exists on disk, the component references the correct config field name,
and no debug marker was ever present in this codebase — that only ever
existed in the separate standalone test-mode artifact, which is a
distinct deliverable from this production component.

**One honest limitation**: `next/image` performs real server-side
transforms that a static-file browser test can't fully replicate outside
a running Next.js server, so — unlike the artifact, which I could
verify end-to-end with headless-browser pixel sampling — this fix is
confirmed correct by direct code/config inspection and CSS-logic
verification, not a live render. `npm run build && npm start` remains
the first genuine end-to-end confirmation.



The hero's location badge ("Indianapolis' Trusted Platform") and skyline
backdrop were hardcoded directly in `TempMoversHero.tsx` — expanding to a
new city would have meant editing the component itself. Added
`config/markets.ts` (one source of truth for city name, badge copy,
backdrop path, and alt text) and `lib/active-market.ts` (resolves the
active market from `NEXT_PUBLIC_ACTIVE_MARKET`, falling back to
Indianapolis if the env var is missing, misspelled, or points at a market
not yet marked `isActive` — so an unapproved city can't silently go live
just because someone set the variable early). The badge now renders
`{market.badgeLabel}` as real DOM text, never baked into the image.

Moved the real approved hero photo (the same one used throughout this
project, not stock) to its market-scoped path,
`public/images/markets/indianapolis/hero-skyline.webp`, matching the
handoff's exact folder structure. Restructured the CSS to the specified
layering approach — `isolation: isolate` on the hero container with the
backdrop image and overlay both at negative z-index, content at
`z-index: 1` — and added the mobile-specific object-position and overlay
gradient adjustments.

**One thing I didn't fabricate**: the handoff's asset structure
(Section 7) describes the hero as individually composited layers —
separate `moving-labor-worker.webp`, `box-truck.webp`, `freight-truck.webp`
files that could be positioned independently of the skyline backdrop. What
actually exists is the one real approved reference photo, which already
has movers and a truck baked into that single image. I did not attempt to
segment or cut out individual subjects from it to fake having separate
layers — that would require actual image-editing/subject-isolation work
I don't have the tooling to do credibly here, and producing a bad
fake cutout would be worse than being upfront that this piece isn't
done. What I built correctly satisfies the handoff's explicit "Important
rule" and "Final Decision" (don't bake the *city name/badge* into the
image — the skyline backdrop itself is fine as a photo) — but item 5 of
the acceptance checklist ("workers, box truck and freight truck remain
separate media or UI layers") isn't met by the current single-photo
backdrop. That would need real separately-shot or professionally
cut-out assets from the design team, not something to approximate here.

I also didn't create a `heroBackdropMobile` asset or reference one in
`config/markets.ts`, since none was actually provided — the handoff
itself (Section 8) explicitly allows skipping the `<picture>`/mobile-
variant approach when no separately optimized mobile backdrop exists,
in favor of `next/image` with `object-position`, which is what's wired
in.



**A third instance of the mover-wage violation, found beyond what the
audit itself flagged.** The audit's own inspection caught the customer
"Rate per mover" selector and the mover's editable "Hourly earnings"
input in `DashboardApp.tsx`. Checking around those turned up a third: a
mover roster showing individual per-mover dollar rates ("Marcus Reed —
$32/hr") with a "Select" button, letting a customer effectively shop by
wage. Fixed all three — service-tier selection (no dollar figures) for
the customer, read-only platform-assigned pay plus a "Request a tier
review" action for the mover, and the roster rate display removed
entirely. Caught two of my own mistakes mid-edit before they shipped: I
initially deleted `setUrgent` by accident (unrelated state, would have
broken the urgent-job toggle), and used a CSS class (`tm-btnSm`) that
only exists on the marketing page's stylesheet, not this dashboard's.

**Mock admin data gated behind `NEXT_PUBLIC_DEMO_MODE`.** Gross booking
volume, platform fees, and the aspirational Chicago/Columbus/Nashville
market rows now show "No live data available yet" outside demo mode
instead of fabricated figures. Indianapolis stays, since it's the real
launch market.

**"Request Freight Quotes" feature-gated** behind
`NEXT_PUBLIC_FREIGHT_QUOTE_REQUESTS_ENABLED` — confirmed by grep, again,
that no carrier bidding/comparison workflow exists anywhere in this
codebase. Falls back to "Post a Freight Load" rather than promising
something customers can't receive.

**Detention charge durability** — added the `DetentionCharge` model
(previously the PaymentIntent ID only ever landed in the audit log, with
no queryable status and no link to driver settlement), rewrote the
charge route to persist every attempt including failures (which
previously just threw and vanished), fixed the metadata key from `jobId`
to `loadId`, and wired the Stripe webhook to update it. **Left
incomplete, honestly**: full driver-ledger linkage. Checked the `Payout`
model specifically for this — it's tightly coupled to `Assignment`
(moving jobs only, via a required unique field); freight loads have no
equivalent payout mechanism to link into at all. That's a deeper,
pre-existing gap than detention settlement alone.

**Worker review notification** — the route's own TODO claimed no
notification provider existed; that was simply stale, since the full
Resend/Twilio system was built several rounds earlier. Wired it in with
a real template and an idempotency key scoped to the specific audit log
entry (so a genuinely new decision of the same type — suspended,
reactivated, suspended again — doesn't get deduped against the first).

**PaymentIntent state protection broadened** — job, freight, and
detention-charge guards previously only blocked on `AUTHORIZED`; now
block on any unresolved status, allowing retry only on `FAILED`.

**`driver-quotes` renamed to `/api/freight/instant-quote`** with an
explicit doc comment distinguishing it from the (not yet built) carrier
marketplace — confirmed zero callers before moving it, so nothing broke.

**Geocoding fallback now flags for review instead of degrading
silently** — added `needsManualGeoReview` to both `Job` and
`CarrierRoute`, set whenever a booking proceeds without coordinates
because Google Maps isn't configured.

**Detention customer-approval question left as an open decision, not
guessed at** — added the supporting schema fields
(`detentionCustomerApprovedAt`/`ById`, `detentionAutoBillingConsentedAt`)
so either answer is ready to wire in, without enforcing either one; this
is a commercial/legal question this pass can't make unilaterally.

### The exact production hero

Implemented `components/marketing/TempMoversHero.tsx` +
`TempMoversHero.module.css` + the exact SVG logo, per the production
handoff — but adapted for how this app actually works, per the
follow-up clarification: **no new routes** (`/login`, `/register`,
`/book/moving-labor`, etc. don't exist and weren't created); every CTA
wires to the same `onGetStarted(intent)` callback the rest of the
homepage already uses, which is genuinely "the existing routes" in an
app built as a callback/state-machine, not a traditional multi-page one.

**On the missing hero asset**: the handoff described a WebP composite
but didn't attach it. Before assuming it was truly absent, checked
`TempMovers_Hero_HTML_Prototype.zip` from earlier in this session — it
contained a real reference photo (`tempmovers-hero-reference.jpg`), the
same one used throughout this project's design references, not generic
stock. Converted it to WebP at the exact specified path
(`public/images/tempmovers-hero-composite.webp`) rather than leaving a
placeholder gradient or fabricating one — this is a real, deployed
asset, not a stand-in. `public/brand/tempmovers-logo.svg` is the exact
SVG from the handoff, verified as well-formed XML — and it happens to
permanently close an earlier bug report about the logo icon and
wordmark visually separating, since they're now baked into one SVG
rather than two adjustable DOM elements.

**Consistency preserved with the rest of Reviewed(16)**: the hero's
stats (10,000+ jobs, 4.9★, 5,000+ professionals) are gated behind the
same `NEXT_PUBLIC_DEMO_MODE` flag as the admin dashboard's mock metrics
— shown only in demo mode, replaced with "Platform stats verified
before public launch" otherwise, per the production handoff's own
Section 9 requirement not to publish unverified numbers. The freight CTA
uses the same `NEXT_PUBLIC_FREIGHT_QUOTE_REQUESTS_ENABLED` gate as the
rest of the homepage, rather than diverging on the same claim across two
components.

`MarketingHomepage.tsx` now renders `<TempMoversHero>` in place of its
own former nav+hero markup, with the existing AI Job Assistant/Service
Cards/How It Works/etc. sections continuing below it — the now-orphaned
hero-only state (`activeQuoteTab`, `freightCtaLabel`, and an
already-unused `assistantDraft` left over from before this pass) was
removed rather than left as dead code.



There was no marketing/logged-out homepage anywhere in this codebase —
`app/page.tsx` went straight to `AuthGate`, which itself went straight to
the login form. A visitor with no account had nothing to see before
being asked to sign in.

Built `components/marketing/MarketingHomepage.tsx` and
`components/marketing/marketing.css` — all 10 requested sections (Hero,
AI Job Assistant, Service Cards, How It Works, Business Solutions,
Worker Recruitment, Trust & Safety, Testimonials, Service Areas, Footer)
plus the nav, using the handoff's exact headline, CTA labels, and nav
items. Built on the app's existing brand blue (`--blue: #246bfd` in
`globals.css`) for continuity with the authenticated dashboard rather
than inventing a disconnected palette, but with its own distinctive type
system (Space Grotesk display / IBM Plex Sans body / IBM Plex Mono for
stats) and a signature element grounded in the actual subject — an
animated dashed route line, used in the quote widget between the
From/To fields and again in "How It Works," which is real route
waypoints (Book → Match → Move → Deliver) rather than decorative
numbering, since order genuinely is the content there.

**Wired into the app, not just built standalone.** `AuthGate`'s status
state gained a `"marketing"` value shown before the login form for any
visitor with no session — previously the union was
`"checking"|"authed"|"unauthed"`; a fresh visitor now sees the homepage
first, and each hero/nav CTA carries an intent (`{ mode, role }`) that
pre-selects the right form and role on `AuthForms` (e.g. "Drive With
TempMovers" lands on registration pre-set to the `DRIVER` role, not a
blank generic sign-up). Signing out now returns to the homepage rather
than dropping straight back to a bare login form; an expired session
still goes straight to sign-in, since that visitor was already mid-use
of the app. Added a "Back to homepage" control on the auth screen so the
homepage is never a dead end once you've clicked through.

**Verified past just a syntax check**: rendered the full homepage
component and confirmed every section's content, all 6 service cards,
and all 4 route waypoints actually appear in the output — two apparent
test failures during that check turned out to be my own test
assertions not accounting for HTML-entity encoding (`&` → `&amp;`,
`'` → `&#x27;`), confirmed and corrected before treating anything as
passing. Also traced `AuthGate`'s full state machine by hand afterward
— every `setStatus` value has a corresponding `status ===` check and
vice versa, no dead or unreachable states, no leftover reference to the
removed `"unauthed"` value (checked directly by name after the lessons
from a similar miss a few rounds back). What I could **not** do: fully
exercise the click-driven state transitions in a real browser — this
sandbox can only render static output per state, not fire `useEffect`
or simulate a click and observe the resulting re-render, so the
transition wiring is verified by structural/state-machine tracing, not
an actual interactive test.

**Deliberately not touched, matching the handoff's own scope note**: no
pricing logic changed anywhere in this pass. The homepage's quote
widget and CTAs are visual/navigational only in this version — they
carry the visitor into the real registration/booking flow rather than
independently computing or submitting a quote themselves.



The handoff's stated goal was to verify existing behavior against the
business rule before changing anything: "movers do not set hourly rates,
customers do not choose mover wages, admin controls market/tier
pricing." That verification found the rule was actively violated, not
just under-specified.

**`POST /api/jobs` accepted `moverHourlyRateCents` directly from the
client** and used it as the mover's actual pay rate — meaning any
customer (or a modified client) could set what movers get paid and what
the job was quoted at, with zero platform control. There was also no
admin-controlled mechanism to resolve a rate from in the first place:
`MarketPricingRule` had platform-fee fields but no wage field, and was
never read by any application code — a schema-only model, confirmed by
grep, not wired to anything. Added `moverHourlyRateCents` to
`MarketPricingRule` and built `lib/pricing-rules.ts`'s
`resolveActivePricingRule()` — the one place a mover wage, box-truck fee,
or semi fee percentage should ever be read from, preferring the most
specific active territory-level rule over a market-wide one, falling
back to the existing platform-default constants when no rule exists yet
for a market. `POST /api/jobs` no longer accepts a rate from the client
at all; it resolves one from the job's market/territory instead.

**Found a second, more severe instance of the identical pattern while
checking whether Stripe uses saved server pricing, per the handoff's own
explicit ask**: `app/api/stripe/job-payment-intent/route.ts` had a
comment claiming *"Never trust a client-supplied quote for the actual
charge amount — recompute it server-side"* — but the recomputation used
`moverHourlyRateCents`/`movers`/`estimatedHours` taken directly from the
request body. Recomputing a quote from client-controlled inputs isn't a
protection; a client can produce whatever total it wants through the
recomputation just as easily as supplying the total directly. This is
the same class of bug fixed in `driver-payment-intent` a few rounds
back, and it had gone unnoticed on the moving-labor side until this
pass. Rewritten to build the PaymentIntent entirely from the job's
already-resolved, already-stored fields (`estimatedTotalCents`,
`customerMoverRateCents`, `moversRequired`, etc.) — nothing from the
request body feeds the charge amount anymore. Also added the same
existing-authorization guard as the freight side (`driver-payment-intent`,
Reviewed(14) item 5) — nothing had stopped a second PaymentIntent from
being created against the same job while one was already outstanding.

**The pre-booking quote-preview endpoint (`/api/quotes` — the homepage's
"Get an Instant Quote" widget) had the same client-supplied-rate field.**
Not a charge-fraud risk since nothing here creates a charge, but a
correctness/honesty one: a customer could see one price in the instant
quote widget and be charged a completely different (correct) one at
actual booking, since the real booking flow now correctly ignores any
client rate. Fixed to resolve the same platform rate the real booking
would use, given an optional origin ZIP/state (falls back to the
platform default when no address context exists yet, matching what a
pre-address marketing-page estimate would need).

**Explicitly checked and found clean**: `WorkerProfile.hourlyRateCents`
is never read by any booking or payment code — confirmed by grep, not
just assumed — so a worker's own profile field doesn't feed pricing
anywhere. `DashboardApp.tsx`'s pricing calculators (moving-labor and
box-truck/semi) are local, client-side preview panels only — confirmed
neither one calls the real booking endpoints, so a demo/admin previewing
"what if the rate were $X" isn't a live violation, just a UI sandbox.

**Explicitly identified, not built — a new workflow, not a fix**: the
handoff's "complex box-truck jobs may use controlled quote requests" and
"specialized freight uses Request Freight Quotes from approved carriers"
describe a negotiated quote-request flow that doesn't exist anywhere in
this codebase yet (confirmed by grep — no matching model or route). This
is materially new scope, not a correction to existing logic, and
deserves its own pass rather than a rushed partial implementation
appended to a fix-verification task.



**Customer total silently dropped accessorial charges.** `POST
/api/loads` was already persisting `accessorialsCents` on the load
record correctly, but the response's `totalCents` only summed
`grossCarrierCents + platformFeeCents` — a customer looking at what they
were quoted right after booking would see a number lower than what the
load actually cost. Fixed.

**Detention configuration was accepted by the schema but silently
discarded.** `waitTimeIncludedMinutes`/`waitTimeRateCents` existed as
database columns with defaults (added last round) but nothing in the API
actually read them from the request or persisted them — every load
silently got the 60-minute/$0 baseline regardless of what the poster
intended. Both are now accepted and saved.

**The full detention workflow, built out**: `POST
/api/loads/[loadId]/detention/calculate` (the assigned driver records
arrival/departure timestamps; the server derives wait time and the
dollar amount via `calculateDetention()` — the driver never submits a
dollar figure directly), `.../approve` (admin-only sign-off, deliberately
separate from calculation so a driver-reported wait time never becomes
billable without a human decision), and `.../charge` (a **separate,
supplemental PaymentIntent** — this never touches or modifies the load's
original authorization, matching the explicit caution carried over from
last round about not silently expanding an existing charge).

**Closed a real double-authorization gap**: nothing previously stopped
`driver-payment-intent` from being called twice for the same load while
an authorization was already outstanding — a second call would create a
second PaymentIntent against the same load with no relationship to the
first. Now blocked with a clear 409 once `paymentStatus === "AUTHORIZED"`.

**Made the load-posting schema actually testable.** It was previously
defined inline inside the route handler, which meant the enforcement
this codebase most needs to prove — that owner-operator loads
structurally cannot include hourly fields, and hourly pricing is only
reachable through the explicit driver-only service type — had no test
coverage at all. Extracted to `lib/loads/post-load-schema.ts` and added
`tests/loads/post-load-schema.test.ts` (10 cases covering exactly that
enforcement plus the detention-default behavior) and
`tests/pricing/detention.test.ts` (7 cases on `calculateDetention`,
including the quarter-hour rounding behavior — a single minute of
overage still bills a full 15-minute increment, verified explicitly
rather than assumed).

**Still unresolved, matching this pass's own remaining-work note**: these
tests are written and syntax-checked but — like every test added in this
codebase so far — have not actually been executed, since no test runner
has network access to install in this environment. Running `npm test` in
a real environment remains the first genuine confirmation they pass.



**Checkr: external idempotency.** The candidate/invitation POST requests
had no `Idempotency-Key` header — if a network response was lost after
Checkr created something but before we saved it, a retry could create a
second real Candidate or Invitation on Checkr's side. Both now send a
stable, per-worker or per-charge key.

**Checkr webhook: unmatched events were being permanently discarded.**
Previously, an event that arrived before its `BackgroundCheck` row
existed (a webhook ordering race, not an invalid event) got marked as a
processed duplicate — a later retry with the same event ID would be
silently rejected forever, even once the record it needed to match
against existed. `ProcessedCheckrEvent` now has a real
`PENDING_RECONCILIATION` → `PROCESSED` lifecycle, and
`lib/screening/reconcile-checkr-events.ts` (wired to
`/api/cron/reconcile-checkr`) retries pending events on a schedule.

**A real, severe bug found while fixing box-truck pricing, not just
stale copy**: `app/api/stripe/driver-payment-intent/route.ts` computed
the PaymentIntent amount **entirely from client-submitted values** —
rate, hours, payout, platform fee, all trusted straight from the request
body. Any caller could request a PaymentIntent for whatever amount it
chose, completely disconnected from what the load was actually posted
at. There was also **no check that the authenticated customer had any
relationship to the load being paid for** — any signed-in customer could
attempt to pay for any load by ID. Both fixed: the amount is now built
entirely from the stored `CarrierRoute` record, and payment is blocked
unless the caller posted the load (`postedByUserId`) or is an admin.

**Closing a loophole in my own prior pass's flat-rate enforcement.**
Last round's `pricingModel: "HOURLY"` opt-in had no actual verification
behind it — any box-truck poster could just claim `HOURLY` and reach the
old per-hour calculation, with nothing distinguishing a legitimate
"customer supplies the truck" booking from someone gaming around
flat-rate pay. Added `FreightServiceType`
(`OWNER_OPERATOR_BOX_TRUCK`/`OWNER_OPERATOR_SEMI`/
`CUSTOMER_SUPPLIED_TRUCK_DRIVER_ONLY`) and converted
`POST /api/loads`'s validation to a Zod discriminated union keyed on it —
each service type's schema branch only accepts the financial fields valid
for it, so an owner-operator submission literally cannot include
`driverHourlyRateCents` at the validation layer, not just by convention.
**Caught and fixed a real bug in my own edit while doing this**: the
runtime pricing logic still referenced a variable (`isSemi`) that the
schema rewrite had deleted — a syntax-only check didn't catch it since
it's a binding/reference error, not a parse error; found by grepping for
the deleted name directly afterward and confirmed no other file had the
same issue.

**`app/api/driver-quotes/route.ts`** and **`components/DashboardApp.tsx`**
updated to the flat-rate calculator and copy — the dashboard's own quote
display had a second latent bug caught before shipping: it checked for a
`driverGrossCents` field the new flat-rate quote doesn't return (it
returns `driverPayoutCents`), which would have silently displayed a
broken amount.

**Detention/waiting-time**: added the tracking fields
(`arrivedAt`/`loadingStartedAt`/`departedPickupAt`/`arrivedDeliveryAt`/
`actualWaitTimeMinutes`/`detentionCents`/`detentionApprovedAt`/
`detentionApprovedById`) and `calculateDetention()` in `lib/pricing.ts`.
Deliberately a **pure calculation only** — nothing wires it into an
actual PaymentIntent capture yet, per the explicit caution that how
detention actually gets collected (captured from an authorized buffer, a
supplemental PaymentIntent, or invoiced separately) is a product decision
this pass doesn't make on its own.



**Checkr hardening** — the previous integration posted `candidate_email`
directly to `/v1/invitations`, skipping Checkr's documented Candidate →
Invitation sequence entirely. `lib/checkr.ts` now creates (or reuses) a
real Candidate first; `lib/screening/start-checkr.ts` reuses a worker's
existing `candidateId` across repeat screenings instead of creating
duplicates. The webhook (`app/api/checkr/webhook/route.ts`) had **zero
duplicate-delivery protection** before this — a redelivered event would
reprocess and re-audit-log indefinitely. Added `ProcessedCheckrEvent`
(the same pattern `ProcessedStripeEvent` already used for the Stripe
webhook), JSON-parse safety, and reconciliation by candidateId, reportId,
*or* invitationId — the old candidateId-only lookup meant an
invitation-object webhook (which has no `candidate_id` field) matched
nothing.

**Real payment method tracking** — every successful screening payment was
recorded as a generic `paymentProvider: "STRIPE"`, regardless of whether
the applicant paid by card, Apple Pay, Afterpay, or anything else. The
Stripe webhook now retrieves the actual PaymentIntent/PaymentMethod and
maps it to a real value (`STRIPE_CARD`/`APPLE_PAY`/`GOOGLE_PAY`/
`CASH_APP_PAY`/`AFTERPAY_CLEARPAY`/`KLARNA`/`LINK`/`AFFIRM`/`OTHER_STRIPE`).

**Freight pay: a genuine business-model reversal, not a bug fix.** Per an
explicit new business decision: box-truck and semi owner-operators supply
their own truck, fuel, insurance, and maintenance, so they're paid a flat
guaranteed amount per load — never derived from hours. Semi already
worked this way; box-truck did not (`driverHourlyRateCents ×
estimatedHours`). `lib/pricing.ts` gained `calculateBoxTruckLoadQuote()`
(flat-rate, same percentage-capped structure semi already uses);
`POST /api/loads` now defaults box-truck to flat-rate, with the old
hourly calculation preserved *only* as an explicit `pricingModel:
"HOURLY"` opt-in for the one exception the business decision itself
carves out — a driver-only booking where the customer supplies the
truck. Added `CarrierRoute.pricingModel` plus `waitTimeIncludedMinutes`/
`waitTimeRateCents`/`accessorialsCents`, since detention/waiting must be
billed separately from the flat rate, not silently absorbed into it.

**Important: this directly reversed a feature added to the sandbox
artifact only a few rounds ago.** The interactive `TempMovers.jsx`
artifact had a live timer + hourly-overage billing built for box-truck
freight, modeled on the *old* hourly business rule. That artifact feature
now demonstrates a pricing model the business has explicitly moved away
from and needs to be reverted/updated to match — flagged to the user
directly rather than left as a silent inconsistency between the two
codebases.

**Deliberately not built this pass** (the freight-pricing handoff's own,
much larger touch-point list): mileage-based pricing
(`loadedMiles`/`deadheadMiles`/`estimatedDurationMinutes` driving the
quote), admin pricing-settings UI, driver-facing UI changes, and customer
checkout copy updates. Also confirmed and documented as a **pre-existing**
gap, not one this pass introduced: the `PricingRule` model has
box-truck/semi fee fields (`boxTruckFeePerHourCents`,
`semiPlatformFeePercent`, etc.) that **nothing in the freight pricing
calculators actually reads** — both `calculateSemiLoadQuote` (already)
and the new `calculateBoxTruckLoadQuote` use hardcoded module constants
instead. Wiring `PricingRule` into freight pricing is a real gap worth
closing, but it predates this change and affects semi equally — fixing it
only for the new box-truck path would have been inconsistent with the
already-shipped semi behavior.



**The most important thing found this round wasn't in the handoff at
all**: `GET /api/jobs` had **no authentication and no field filtering**.
Anyone, logged in or not, could call it and receive up to 50 full `Job`
records — exact GPS coordinates, internal platform-fee/margin fields, and
Stripe payment identifiers included. This wasn't "sanitization has a gap"
— there was no protection whatsoever. Found while checking whether moving
jobs had the same address protection freight loads already did (they
did — freight was fine, both `app/api/loads/route.ts` and
`app/api/driver/loads/route.ts` already excluded exact addresses and
private fields correctly). Fixed: the route now requires auth and scopes
by role — a customer sees only their own full jobs, a mover/driver gets a
new sanitized preview (`lib/access/sanitize-job.ts`), an admin gets full
access. No frontend code called this route, so nothing broke — but it was
live and reachable regardless.

**A real schema defect the handoff itself flagged as a migration
blocker was confirmed real**: `WorkerProfile` had two fields both named
`ratingAverage` — an old, completely unused `Decimal` one from early
scaffolding, and the `Float` one the review system actually writes to.
This would have broken `prisma generate` outright. Removed the dead one,
then wrote a one-off script to scan the *entire* schema for any other
duplicate field names before proceeding — it was the only one.

**The screening payment flow itself**, per the handoff:
- `lib/screening/packages.ts` — per-role Checkr package + price resolver
  (Mover/Box-Truck/Semi), explicitly documented as configuration defaults
  needing a real admin-managed pricing table before production, not
  hard-coded legal promises
- `POST /api/screening/checkout` — one-time Stripe Checkout session,
  `automatic_payment_methods` enabled so Stripe shows Afterpay only when
  it determines eligibility (never forced), kept in **payment mode**,
  entirely separate from the recurring subscription checkout — Afterpay
  doesn't support Checkout subscription mode at all, so these must never
  be the same flow
- Webhook: a new `checkout.session.completed` branch matched specifically
  on `metadata.type === "SCREENING_CHARGE"` (distinct namespace from the
  subscription branch already there, so the two flows can't be confused
  even sharing one handler), plus a new `charge.dispute.created` handler
  that restricts opportunity access immediately when a screening payment
  is disputed — not only once a dispute is lost
- `lib/screening/start-checkr.ts` — launches the Checkr invitation only
  after confirmed payment, idempotent (a charge with an existing
  `BackgroundCheck` is a no-op), and isolates a Checkr-side failure from
  the payment's own success — the charge stays `PAID`, an alert fires,
  and it's retryable via the new admin route, never silently re-charged

**The compliance/access layer**:
- `lib/access/opportunity-access.ts` — `evaluateOpportunityAccess()`
  (pure policy function) plus `checkOpportunityAccess()` (the DB-backed
  convenience wrapper every route actually calls). Deliberately narrower
  in scope than the existing `lib/worker-eligibility.ts`: that answers "is
  this worker allowed to touch loads/jobs/payouts at all" (subscription,
  Stripe, onboarding); this answers "given that baseline, what can they
  see and do with *this specific* opportunity." Wired into both the
  moving-job assignment route and the freight load-request route,
  alongside (not replacing) the existing eligibility gate
- `lib/access/sanitize-load.ts` — extracted from what was already
  independently (and correctly) duplicated across the two freight
  routes, so a future field addition can't leak through one list but not
  the other
- `components/opportunities/ComplianceGate.tsx` — the locked-state UI
  wrapper; deliberately only ever receives an `AccessDecision`, never the
  underlying job/load record, so there's no client-side data to leak in
  the first place
- `app/onboarding/screening/page.tsx` — real quote display, fee/FCRA
  disclosure checkboxes gating checkout, live status polling after
  redirect back from Stripe

**Admin compliance/screening actions**: approve/restrict/suspend/
reactivate (`/api/admin/compliance/[workerId]/decide`), sponsorship that
invokes the identical Checkr-start path a real payment would, without
fabricating a paid Stripe event (`/api/admin/screening/[chargeId]/sponsor`),
refund — explicitly blocked once screening has actually been ordered with
Checkr, matching the handoff's distinction between "before" and "after"
third-party cost is incurred (`/api/admin/screening/[chargeId]/refund`),
and retry for a payment-succeeded-but-invitation-failed charge, without
re-charging (`/api/admin/screening/[chargeId]/retry`).

**Deliberately not built this pass:**
- Automated test suite (`tests/integration/access-gate.test.ts` etc.) —
  no test framework is configured in this codebase at all; adding one is
  a real prerequisite the handoff's own "release blocker" language
  implies, not something to bootstrap as a side effect of this change
- Admin UI screens beyond the API routes — same pattern as every prior
  admin feature in this codebase, API-first

## WorkerCompliance track sync + Checkr package reconciliation (follow-up)

Two items flagged as deferred above are now resolved:

- **`WorkerCompliance`'s per-credential-track fields are now populated
  automatically.** `lib/compliance/sync-tracks.ts` — `syncWorkerComplianceTracks()`
  — recomputes `identityStatus`/`backgroundStatus`/`licenseStatus`/
  `mvrStatus`/`insuranceStatus`/`vehicleStatus`/`dotStatus`/`mcStatus`/
  `cdlStatus` from the actual underlying records (`WorkerDocument`,
  `BackgroundCheck`, `CarrierVerification`, `InsurancePolicy`) rather than
  leaving them at their `NOT_STARTED` default forever. Wired into all four
  places one of these could change: document submission/decision
  (`/api/workers/[workerId]/verification`), the Checkr webhook, FMCSA
  verification (`lib/fmcsa.ts`), and the Certificial webhook. The overall
  `adminApprovalStatus` gate — the one `checkOpportunityAccess()` actually
  checks — stays admin-only, untouched by this; this only keeps the
  informational per-track breakdown accurate for whoever's reviewing it.
  One documented approximation: there's no distinct "MVR" record in this
  schema, since motor vehicle checks come back as part of the same Checkr
  report as the background check for driver types — `mvrStatus` mirrors
  `backgroundStatus` for drivers rather than tracking separately.

- **The two parallel Checkr entry points are reconciled.** The older
  admin-manual invite route (`app/api/checkr/invite/route.ts`,
  `checkrPackageForWorkerType()`, a 2-package system) turned out to be a
  real correctness gap, not just duplication: it created a
  `BackgroundCheck` with no corresponding `ScreeningCharge`, which meant a
  worker invited that way would silently never satisfy
  `checkOpportunityAccess()`'s screening-payment check — the compliance
  gate would think they were never screened at all, regardless of the
  Checkr result. Removed it; `POST /api/admin/screening/[chargeId]/sponsor`
  already covers the same admin-initiated use case correctly (creates the
  `ScreeningCharge`, marks it `PLATFORM_SPONSORED`, then calls the same
  `startCheckrScreening()` a real payment would). One Checkr package
  system now: `lib/screening/packages.ts`'s three roles
  (`CHECKR_MOVER_PACKAGE`/`CHECKR_BOX_TRUCK_PACKAGE`/`CHECKR_SEMI_PACKAGE`).



Implements the launch-integrations handoff's P0 stack plus a solid pass at
P1. P2 (DAT/Truckstop/123Loadboard) is explicitly **not** activated here —
the handoff itself says freight shouldn't go live until contracts and
certification exist, and `lib/load-board-adapter.ts`'s honest stubs (from
several rounds back) already reflect that correctly.

**Notification orchestration (`lib/notifications/index.ts`)** — the
single place business logic sends anything, rather than every route
calling Resend/Twilio directly. Idempotent (one `Notification` row per
`idempotencyKey`, per channel), respects `emailSuppressedAt`/`smsOptOutAt`,
and — this took a second pass to get right — genuinely never throws: the
first draft's own initial user lookup wasn't actually covered by its
internal try/catch, which would have let a DB hiccup there propagate up
into whatever business action triggered the notification.

**Resend** (`lib/email/resend.ts` + `lib/email/templates/*`) — real client,
~10 transactional templates, webhook with bounce/complaint-driven address
suppression.

**Twilio** (`lib/twilio.ts`) — real client, phone verification
(`/api/auth/phone/start`/`verify`), SMS sending, and a status webhook that
verifies Twilio's request signature and handles STOP/HELP/START keyword
opt-out/opt-in against `User.smsOptOutAt` — not just delivery-status
callbacks.

**Private file storage** (`lib/storage.ts`, S3-compatible, KMS-encrypted,
signed upload/download URLs) — and this is the one that actually changed
existing UI: the onboarding forms' credentials/insurance/DOT-MC steps used
to accept a pasted URL as a placeholder (documented as such several
rounds ago). They now do a real file upload. Caught a design flaw in my
own first draft before it shipped: the presign endpoint and the existing
verification-submission endpoint would both have tried to create the
`WorkerDocument` row for the same upload. Fixed by having presign return
only the signed URL/key; the verification endpoint remains the single
place the document record is created.

**Google Maps** — wired real geocoding into both job posting and freight
load posting (previously built but never called from either). Degrades to
proceeding without coordinates if unconfigured, rather than blocking every
booking on an optional provider — but does reject an address that fails to
geocode when the provider *is* configured, since that usually means the
address itself is invalid.

**A real security fix found while implementing this**: Stripe checkout
`successUrl`/`cancelUrl` were accepted directly from the client — an
open-redirect-shaped risk on a Stripe-hosted payment flow. Fixed to derive
both server-side from `NEXT_PUBLIC_APP_URL`, and cleaned up the two
frontend callers that were sending them.

**Sentry** (`sentry.{client,server,edge}.config.ts` + `lib/monitoring.ts`)
— config plus an explicit `captureIntegrationAlert()` helper for the
"nothing threw, but this needs a human" cases automatic instrumentation
wouldn't catch (a payout stuck `PROCESSING`, an unreconcilable transfer).
Using this to wire actual monitoring surfaced a real bug: bonus-generator
calls after a successful payment capture were unguarded, so a failure
there would have turned an *already-successful* Stripe capture into a 500
response to the caller. Fixed in both the moving-job and freight capture
routes — capture success is now never undone by an unrelated accounting
failure downstream of it.

**Checkr** (`lib/checkr.ts`) — candidate invitation and a webhook that
records results but deliberately does **not** auto-reject on a "consider"
result — adverse action on a background check has real FCRA requirements
(pre-adverse notice, waiting period, dispute process) that need counsel
review, not an automated handler. Flags for admin review instead.

**FMCSA** — `reverifyExpiredCarriers()`, a cron endpoint
(`/api/cron/fmcsa-reverify`, shared-secret protected — configure via
Vercel Cron or an external scheduler), and an admin manual-refresh button.
This one *does* auto-restrict on a failed reverification: FMCSA operating
authority is the government's own live record, an objective fact rather
than a private report needing an adverse-action process — worth keeping
that distinction straight against Checkr's opposite behavior above.

**Certificial** — webhook that also auto-restricts on a coverage
lapse/cancellation, same reasoning as FMCSA. Notably required **no changes
anywhere else**: `operationalStatus` is already checked by the shared
eligibility evaluator everywhere that matters, so setting it to
`RESTRICTED` here correctly and immediately blocks new freight requests
without any additional wiring.

**Notification trigger points actually wired** (not just templates sitting
unused): booking confirmation, assignment notice, payment receipt +
review request (on capture), payout initiated/transferred/failed/offset,
subscription confirmation/cancellation, document submitted/approved/
rejected, and private-load invitation — this last one closes a `TODO` that
had been sitting in the invitations route since the private-load
workflow was first built, several rounds back.

**A second idempotency-key mistake I caught mid-build**: while wiring the
document-decision notification, I initially keyed it with `Date.now()` —
the exact same defeats-the-purpose mistake as the Stripe checkout
idempotency bug found earlier this session. Caught it before finishing
and keyed it off the specific document ID instead, which is stable across
a genuine retry of the same decision.

**Deliberately not built:**
- DAT/Truckstop/123Loadboard real integrations — per the handoff's own
  explicit recommendation, these stay honest stubs until contracts and
  certification exist
- Malware scanning on uploaded documents — this is an infrastructure-level
  concern (an S3 event trigger + a scanning service), not something
  expressible as application code in this Next.js project
- Subscription renewal-failure notification — the template exists
  (`subscriptionRenewalFailureTemplate`) but isn't wired to a trigger yet
- A `vercel.json` / CI workflow file — see "Deployment" below for the
  documented requirements instead

### Deployment (Vercel) and database

- Separate Vercel projects/environments for preview, staging, and
  production, each with its own full environment-variable set from
  `.env.example`
- Configure Stripe, Resend, Twilio, Checkr, and Certificial webhook URLs to
  point at the deployed domain for each environment separately — a preview
  deployment's webhook events should never land in production data
- Protect preview deployments (Vercel's deployment protection) since they
  can reach real third-party sandboxes
- Configure `/api/cron/fmcsa-reverify` as a Vercel Cron job (or point an
  external scheduler at it) running roughly every 24 hours, with the
  `Authorization: Bearer <CRON_SECRET>` header
- Managed PostgreSQL (Neon, RDS, or similar): separate staging/production
  databases, automated backups with point-in-time recovery, pooled
  `DATABASE_URL` for application traffic and `DIRECT_URL` for migrations
  where the provider requires it, and credential rotation on any team
  access change
- Document the migration/rollback procedure for the specific provider
  chosen — that's provider-specific enough that it isn't written generically
  here



The prior `Review` model was a bare skeleton (rating, comment, job/worker
relation) with no submission workflow, no moderation, and no real
integration with the bonus generator beyond what I'd bolted on in earlier
rounds. Built out per the review-system handoff:

- **Schema**: `Review` expanded with `customerId`, `tags` (`ReviewTag[]`),
  `status` (`ReviewStatus`: PENDING/PUBLISHED/HIDDEN/REMOVED), and
  moderation fields (`reportedAt`/`reportReason`/`moderatedAt`/
  `moderatedBy`). `WorkerProfile` gained `ratingAverage`/`ratingCount`/
  `fiveStarReviewCount`, recalculated — never written directly anywhere
  else — by `lib/reviews.ts`.
- **`GET`/`POST /api/jobs/[jobId]/reviews`** — lists reviewable (approved,
  not-yet-reviewed) assigned workers on a completed+captured job, and
  submits one review per worker per job. Ownership, job status, payment
  status, and "was this worker actually an approved assignment on this
  job" are all checked in a single query that fails closed rather than
  leaking which specific condition failed. Duplicate submission is
  rejected via the existing `@@unique([jobId, workerId])` constraint
  (P2002 caught and turned into a clear 409, not swallowed).
- **`app/customer/jobs/[jobId]/review/page.tsx`** — the actual customer
  form: star rating, optional tags, optional comment, one card per
  reviewable mover, already-reviewed state handled per worker.
- **`generateThreeFiveStarBonus`** (in `lib/bonus-generators.ts`) updated
  to filter on the new `status: "PUBLISHED"` field — a HIDDEN or REMOVED
  review must never count toward the bonus threshold, and didn't have a
  status field to check before this pass.
- **Moderation**: `GET /api/admin/reviews` (filterable by status/reported),
  `POST .../hide`, `.../restore`, `.../remove` (reason required for
  hide/remove, all three recalculate the affected worker's rating
  immediately via a shared `lib/review-moderation.ts` helper — a hidden
  review falls out of the public rating and bonus qualification the
  moment it's hidden, not eventually), and `POST
  /api/reviews/[reviewId]/report` (a worker can flag a review about
  themselves but has no path to hide or remove it directly — only the
  admin routes can).

**Deliberately not built this pass** (matches the handoff's own P1/P2
framing): the post-job review-prompt notification flow (in-app card +
email + 24h reminder) — no notification provider is wired in this
codebase at all, a standing gap noted since several rounds back; the
customer dashboard's "Leave a review / Reviews completed" badge wiring
into the existing mock dashboard component; a 24-hour edit window via
PATCH; and request-rate limiting on the review endpoints specifically
(no rate-limiting middleware exists anywhere in this codebase yet, not
review-specific).



**Multiple movers on one job couldn't all get their first-job bonus.**
`generateMoverFirstJobBonus` used the job's ID alone as the qualifying-entity
key. Since a moving job can have 2+ movers, the first one to hit the
`(programId, qualifyingEntityId)` unique constraint would get the award —
the second, equally-qualifying mover would silently get nothing, their
attempt swallowed as an "already exists" no-op. Fixed by scoping the key to
the specific `(job, worker)` pair instead of the job alone.

**`completedJobs` was never incremented anywhere in a normal, authenticated
workflow.** The only place that touched it was
`/api/workers/[workerId]/complete-first-job` — which had **no auth check at
all**. Anyone could POST to it for any `workerId` and manipulate that
worker's completed-job count and first-job waiver eligibility directly,
which feeds straight into subscription billing and every bonus generator's
qualification check. Fixed both problems together: `completedJobs`/
`firstCompletedJobAt` now advance inside the actual safe workflows —
`POST /api/assignments/[assignmentId]/approve` for moving jobs, `POST
/api/loads/[loadId]/status` on the `SETTLED` transition for freight — both
authenticated, both transactional, both tied to real approved/settled
work. The standalone endpoint is now admin-only and audited, kept as a
manual correction tool rather than a workflow step.

**Bonus generation was swallowing every database error, not just duplicate
awards.** `tryCreateAward`'s `catch {}` treated *any* failure — a bad
foreign key, a connection drop, an actual bug — the same as an expected
"this award already exists" no-op. Now checks specifically for Prisma's
unique-constraint error (`P2002`) and rethrows everything else.

**Three-5-star qualification didn't check payment was actually captured.**
The code comment claimed it did ("only ratings tied to a job that
completed and was paid"), but the query only checked `job.status ===
"COMPLETED"` — never `paymentStatus`. A job could complete with a failed
or never-captured payment and still count toward the threshold. Added the
`paymentStatus: "CAPTURED"` condition the comment already claimed existed.



**Checkout idempotency key changed on every request.** The Stripe
idempotency key for `worker-subscription` checkout sessions included
`Date.now()`, meaning every call — including a genuine retry of the exact
same logical request — generated a brand-new key. This completely
defeated the purpose: idempotency only works if a retry reuses the same
key. Fixed to a stable `worker-{id}:{plan}` key, matching the pattern
already used everywhere else in this codebase (job-payment-intent,
Connect account creation, payout transfers).

**Automatic bonus-award generation, built for real this time.**
`lib/bonus-generators.ts` — six generators (customer first-booking credit,
mover first-job bonus, three-5-star-jobs bonus, mover referral bonus,
driver referral bonus, partner referral credit), each idempotent via the
`BonusAward` unique constraint on `(programId, qualifyingEntityId)` —
upgraded from a plain index to an actual unique constraint, since an
index alone never stopped a duplicate award. Wired into the moment that
actually matters: successful payment **capture** (`POST
/api/jobs/[jobId]/capture-payment` and the freight equivalent), not job
completion alone, which can happen before money ever clears. Uses the
already-seeded `BonusProgram` rows from `prisma/seed.ts` rather than
hardcoding amounts again.

This required adding worker-to-worker referral tracking
(`WorkerProfile.referredByWorkerId`) that didn't exist anywhere — the
mover/driver referral bonuses had no data to key off before this.
**Honest gap left open:** nothing currently populates
`referredByWorkerId` (no referral-code-entry UI at registration), and
freight work doesn't increment `WorkerProfile.completedJobs` the way
moving-job approval does — so the driver referral generator is real and
wired, but will correctly return "not yet qualified" until both of those
prerequisites exist. Documented in-line rather than silently left broken.

**`PayoutOperation` is now actually used**, not schema-only. Created
*before* the Stripe transfer call (inside the same transaction that marks
the payout `PROCESSING`), updated to `COMPLETED`/`FAILED` after Stripe
responds. `PROCESSING`-payout reconciliation now checks this durable
record first — a real operation-tracking table, not just a hope that a
transfer shows up in the last 100 — and only falls back to listing recent
Stripe transfers if no operation record exists (e.g. a payout stuck from
before this table existed) or if the operation is inconclusive.

**Subscription activation timestamp.** `WorkerProfile.subscriptionActivatedAt`
existed in the schema since the Reviewed(6) pass but nothing ever set it.
Now recorded in the `checkout.session.completed` handler, the actual
first-activation moment.



**Highest-risk fix: Stripe subscriptions weren't reliably linked back to
WorkerProfile.** `worker-subscription`'s checkout session only put
`workerId`/`plan` in `subscription_data.metadata`, never the top-level
session `metadata` — but `checkout.session.completed` (which didn't have a
handler at all) is the only event that sees the top-level metadata, and
nothing else ever saved `WorkerProfile.stripeSubscriptionId` in the first
place. Every later `customer.subscription.updated` query for
`stripeSubscriptionId` was matching nothing. Fixed: metadata on both
levels, a real `checkout.session.completed` handler that does the actual
link-back, and later subscription events now fall back to
`sub.metadata.workerId` if the `stripeSubscriptionId` lookup finds nothing
(covers subscriptions created outside our own checkout flow or webhook
ordering races).

**Two other subscription bugs in the same route:** a waived mover's plan
selection was never actually saved (`subscriptionPlan` stayed null, so the
onboarding evaluator kept the subscription step incomplete forever even
though the worker had "selected" a plan) — fixed to save `subscriptionPlan:
"MOVER"` with `subscriptionStatus: "INCOMPLETE"`. And subscription plans
had no server-side worker-type restriction at all — a mover could
subscribe to Owner-Operator Pro, a semi driver could under-subscribe to
Driver Basic. Added `planAllowedForWorker()`, and fixed the frontend
dropdown to match exactly (it was also broken in a way that made it worse:
`workerType` was never actually passed down to any form component, so
every worker saw the same static option list regardless of their actual
type).

**Missing onboarding forms** — `FORM_COMPONENTS` only registered personal/
business/vehicle/territory/payments/subscription; credentials, insurance,
and DOT/MC had no form at all, so those steps were permanently disabled
in the UI with no way to complete them. Added all three, each posting to
`/api/workers/[workerId]/verification`.

**That verification route never persisted anything** — it flipped a
status string to `IN_REVIEW` but never created a `WorkerDocument` record,
so the submitted file, expiration, and review history didn't exist
anywhere. Now creates the document, updates the status, and audits — all
in one transaction. The admin decision endpoint also updates the matching
document's own review trail, not just the coarser profile-level status.

**A real "not applicable" bug** — insurance for a labor-only mover
returned `NOT_STARTED` instead of `NOT_APPLICABLE`. Since the frontend's
submit gate requires every *non*-`NOT_APPLICABLE` step to be `COMPLETE`,
this meant a mover could never actually finish onboarding despite my own
code comment claiming it "wasn't a hard blocker" — the comment was
aspirational, the code didn't achieve it. Fixed.

**Duplicate, disagreeing verification gates** — the load-request route ran
`evaluateWorkerEligibility()` and then a separate route-local
`verificationGate()` checking *different underlying fields*
(`dotMcVerificationStatus` vs. `carrierVerification.decision` for DOT/MC;
vehicle profile completeness had no admin-approval check at all in the
shared evaluator). Deleted the duplicate; folded `vehicleVerificationStatus`
and an FMCSA-or-manual DOT/MC check properly into the shared evaluator so
there's exactly one source of truth.

**P1s also closed:** the freight board (`GET /api/driver/loads`) still
allowed `MOVER` accounts to browse it even though requesting was already
DRIVER-only — fixed. Added the `PayoutOperation` schema for durable payout
reconciliation, **not yet wired into the payout route** — the existing
list-and-match-recent-transfers approach remains the active mechanism
(fine for a small supervised pilot, not durable at scale, exactly as
flagged).

**Still open, explicitly not attempted this round:** automatic bonus
award generation (first-job bonus, referral bonuses, three-5-star bonus)
firing from real platform events — this remains sandbox-only business
logic, same gap noted in the Reviewed(5) section above. Wiring
`PayoutOperation` into the actual payout route plus a scheduled
reconciliation worker is also still open.



**The onboarding forms are now real, not just a progress display.**
`components/OnboardingStatusPage.tsx` has working forms for personal
profile, business/carrier profile (semi drivers only), vehicle + insurance
(carriers only), territory, Stripe Connect, and subscription selection —
each loads existing values, saves independently, and refreshes progress.
Scoped as one consolidated page with expandable sections rather than the
14 separate route files a fully literal build would use (`/onboarding/
driver/personal/page.tsx`, etc.) — functionally equivalent (same
save-and-return behavior, same per-step validation, same submit gating),
far less file overhead. New save endpoints:
`/api/driver/profile`, `/api/driver/vehicles`, `/api/driver/business`,
`/api/driver/territories` (each calls `markOnboardingStarted()` on first
save, closing the "status can go stale" gap).

**One shared evaluator, not four copies of the rules.**
`lib/worker-eligibility.ts` — `evaluateWorkerEligibility()` — replaces the
narrower `lib/driver-eligibility.ts` (deleted) and is now the single thing
onboarding progress, submission, admin approval, moving-job acceptance,
freight-load requests, and payout all call. This is what actually fixed
two real bugs, not just consolidated code:
- **Movers no longer require a vehicle.** The evaluator marks vehicle/
  business/DOT-MC steps `NOT_APPLICABLE` for labor-only movers instead of
  blocking them on a carrier requirement that never applied.
- **Insurance rules are worker-type-specific** — commercial vehicle+cargo
  insurance is required for carriers; a mover's general-liability step is
  informational, not a hard onboarding blocker.
- Caught a circularity bug before it shipped: `ADMIN_APPROVAL` context
  checks the *substantive* requirements (documents, Stripe, subscription,
  market), never the `operationalStatus`/`onboardingStatus`/
  `overallVerificationStatus` fields themselves — those are exactly what
  the approval action is about to set, so gating approval on "is already
  approved" would always fail for a worker's first approval.

**Plan eligibility now checks the actual requested load's equipment**, not
just workerType — `planAllowsLoad({ plan, workerType, equipmentType })`
closes the real gap where a Driver Basic box-truck account could
previously request a semi load (the old check only compared plan against
workerType, never against what was actually being requested).

**Admin approval recalculates eligibility, not just trusts SUBMITTED
status** — requirements can change after submission (a document expires,
Stripe status changes); approval now re-runs the same shared evaluator.

**Payout retry + PROCESSING reconciliation** — a FAILED payout can now be
retried through the same endpoint (reusing the same Stripe idempotency
key, so a retry can't create a duplicate transfer even if the retry logic
itself has a bug), with `retryCount` tracked. A payout stuck `PROCESSING`
(Stripe transfer succeeded but the DB update after it never landed) is
reconciled by listing recent Stripe transfers and matching on
`metadata.payoutId` before allowing any further action — documented as a
stopgap pending a real payout-operation-record + scheduled reconciliation
worker, exactly as the audit recommended.

**Bonus ledger AWARD/PAYMENT entries** — found that nothing ever created
these, and no path ever set a `BonusAward` to `PAID`, meaning the
RECOVERY-on-refund path in `lib/bonus-ledger.ts` was unreachable in
practice (every award would hit VOIDED instead, since it could never
reach PAID). Added a `pay` decision to the bonus award review route that
transitions APPROVED → PAID and creates the PAYMENT ledger entry, plus an
AWARD entry at approval time. Documented the full sign convention in that
file: AWARD positive, PAYMENT negative (nets to zero once paid), RECOVERY
negative (debt), ADJUSTMENT positive (debt collected). **Still open:** the
business logic that actually *creates* `BonusAward` rows in the first
place (first-job bonus, referral bonus, three-5-star bonus) exists only in
the sandbox artifact — never ported to the real backend. This round fixed
the ledger accounting for awards that exist; it didn't build what creates
them.



A third-round audit found the onboarding work from the previous session had
a release-blocking regression, plus real gaps in payout-recovery safety.

**The critical bug:** `POST /api/auth/register` set `User.status: "PENDING"`,
but `verifySession()` (added in an earlier hardening pass) rejects any user
whose status isn't `ACTIVE`. Every newly registered account got a JWT that
failed authentication on its very next request — `/api/me` and every
onboarding endpoint included. `User.status` is the account-security state
(suspended/closed); it was never supposed to carry onboarding progress —
that's what `WorkerProfile.onboardingStatus`/`operationalStatus` are for,
and they were already correctly restricted. Fixed: registration now sets
`status: "ACTIVE"` and leaves the actual work-access restriction to the
WorkerProfile fields where it belongs.

**A second regression found while fixing the first:** `AuthGate.tsx` never
sent `acceptedTerms`, `homeZip`, or `marketingConsent` — fields the backend
had required since the prior session. Registration was completely broken
from the actual UI, not just failing after the fact. Fixed both sides
together: the form now collects home ZIP (movers/drivers only) and a
required terms checkbox, and handles the `nextStep` redirect. Since that
redirect pointed at `/onboarding/driver`, a page that didn't exist, also
built a minimal (not the full 8-step wizard — that's still separate, larger
frontend work) onboarding status page so the redirect has a real
destination instead of a 404.

**Also fixed this round:**
- Registration now validates role/workerType combinations server-side
  (a DRIVER account with workerType MOVER was silently possible before),
  wraps user + profile + WorkerMarket + consent creation in one
  transaction, and rejects signup outright if no market is actually
  recruiting workers in that ZIP (`workerRecruitingEnabled`, not just "has
  this ZIP on file")
- `canRequestLoad` gained an `acceptingJobs` check and is now enforced on
  moving-job acceptance too (previously only checked identity verification,
  not the full onboarding/subscription/Stripe gate)
- Freight requests are now DRIVER-role-only (movers could previously
  request freight loads) with an explicit workerType assertion, and a
  plan/equipment eligibility check (`planAllowsEquipment`) blocks a
  Driver-Basic-only worker from requesting semi freight
- **Payout/bonus-recovery transaction safety** — the real complexity of this
  round. Rewrote the recovery-balance reservation to happen atomically with
  the payout status check (inside one `$transaction`), allocate against
  whichever bonus award *actually* carries outstanding debt (the prior
  version could tag a completely unrelated, zero-debt award as the
  source), release the reservation if the Stripe transfer itself fails
  (previously a failed transfer could still leave the debt looking
  recovered), and reach a real terminal `OFFSET` status when recovery fully
  consumes a payout instead of a generic conflict error that left the
  payout stuck `SCHEDULED`
- `WorkerDocument` and `UserConsent` (versioned, with IP/user-agent) added
  to the schema; real `UserConsent` records now get created during
  registration alongside the simple `termsAcceptedAt` flag

**A bug I found through my own verification, not from the audit doc:**
`prisma/seed.ts` creates its own `LaunchMarket` with a different code
(`"INDY"`) than `prisma/backfill-geo.ts` (`"US-IN-INDY"`) — two separate
markets depending on which script ran, and the primary seed script's market
had every enable flag defaulting to `false`. Running only `npm run
prisma:seed` (the normal first step) would have made registration, job
posting, and load posting all reject with "not currently accepting"
errors. Fixed the flags and reconciled both scripts onto the same
`"INDY"` code.



Implements the account-state and eligibility-gating workflow from the driver
onboarding handoff. Extended the existing `WorkerProfile` (shared by movers
and drivers) rather than adding a parallel `DriverProfile` model, since a
second worker model would fragment logic that's already unified.

**What's implemented:**
- `WorkerProfile` gained `onboardingStatus` (INCOMPLETE/IN_PROGRESS/SUBMITTED/COMPLETE),
  `overallVerificationStatus` (PENDING/IN_REVIEW/APPROVED/REJECTED/EXPIRED/SUSPENDED),
  and `operationalStatus` (PENDING/ACTIVE/RESTRICTED/SUSPENDED/CLOSED) — named
  distinctly from `User.status` (a platform-wide account state, not a
  worker-specific operational one) and from the granular per-document
  verification strings already on this model
- `lib/driver-eligibility.ts` — `canRequestLoad()`, the single consolidated
  gate, plus `explainIneligibility()` for surfacing *why* to the worker
  instead of a bare 403. Wired into: `GET /api/driver/loads` (browsing stays
  allowed during review, per the access table — only the response now says
  whether requesting is actually possible), `POST /api/loads/[loadId]/request`,
  and private invitation acceptance
- `POST /api/auth/register` now collects only what the recommended signup
  screen asks for (name, email, category, home ZIP, terms acceptance),
  records consent (`User.termsAcceptedAt`/`marketingConsent`), creates the
  account in the deliberately restricted starting state, seeds a primary
  market + `WorkerMarket` row from the ZIP when it resolves, and returns
  `redirectTo: "/onboarding/driver"` for movers/drivers
- `GET /api/driver/onboarding` — the progress API, computing each step's
  status from real data (never a client-reported flag)
- `POST /api/driver/onboarding/submit` — moves a worker into the admin
  review queue, but only once every step actually checks out server-side
- `POST /api/admin/workers/[workerId]/review` — the only path to
  `onboardingStatus: COMPLETE` / `operationalStatus: ACTIVE`. Approve/reject/
  suspend/reactivate, reason required for reject/suspend, fully audited
- Payout creation gets a narrower safety check: blocks on active
  suspension/closure, but deliberately does NOT apply the full
  `canRequestLoad` gate there — work already legitimately performed
  shouldn't go unpaid because a subscription lapsed afterward
- Seed data (`prisma/seed.ts`) updated to the fully-approved end state —
  without this, the new gate would have locked the demo movers/drivers out
  by default, since every new field defaults to the restricted starting state

**Deliberately not built this pass:**
- The actual `/onboarding/driver` frontend wizard (personal/business/vehicle/
  credentials/insurance/payments/subscription/territory steps) — this
  handoff was explicit that the backend gating is what's safety-critical
  ("frontend filters are not sufficient"); the multi-step wizard UI is a
  separate, large frontend build
- Document expiration auto-restriction (insurance/registration/CDL expiry
  automatically flipping `operationalStatus`) — the fields exist
  (`insuranceExpiresAt`, `registrationExpiresAt` on `Vehicle`), nothing
  scans them yet
- Duplicate-account prevention by normalized phone/USDOT/MC/VIN (email
  uniqueness is enforced; the others aren't cross-checked)
- Admin document review UI, FMCSA result display, or a worker-facing status
  page — API-only



A follow-up audit of the previous update found 8 P0 gaps blocking live
payments/pilot testing. All 8 are now fixed:

1. **Jobs had no market/territory assigned at creation** (`POST /api/jobs`)
   — a job's `marketId` stayed null forever, and since job acceptance is
   geographically gated, an unassigned job could become impossible for any
   mover to ever accept. Now resolves market by state+ZIP, rejects booking
   outside an `publicBookingEnabled` market, resolves territory, and stores
   the address's coordinates on the job.
2. **Same gap for freight loads** (`POST /api/loads`) — the load board
   filters by `originMarketId`, but nothing set it on posting, so a load
   could be created and remain invisible to every driver. Fixed the same way,
   gated on `freightEnabled`.
3. **Webhook replay protection recorded events as done before processing
   them** — a failure partway through (e.g. the DB write for a refund) would
   be permanently lost, because Stripe's retry would see the event already
   "handled" and back off. `ProcessedStripeEvent` now tracks
   PROCESSING → COMPLETED/FAILED, and only COMPLETED short-circuits a retry.
4. **Bonus recovery idempotency was per-event, not per-award** — one refund
   affecting three bonus awards would only recover the first one; the other
   two silently kept their PAID status uncorrected. Fixed the unique
   constraint from `(stripeEventId, type)` to
   `(bonusAwardId, stripeEventId, type)`.
5. **Negative bonus balances were recorded but never collected** — a
   RECOVERY ledger entry existed, but nothing ever deducted it from a future
   payout. Added `getWorkerBonusRecoveryBalance()` and
   `applyBonusRecoveryToPayout()` (`lib/bonus-ledger.ts`), wired into
   `POST /api/payouts/[payoutId]/pay` — capped at the payout's gross (never
   goes negative), with an ADJUSTMENT ledger entry so the same debt can't be
   deducted twice across multiple payouts.
6. **Freight capture accepted DELIVERED status alone** — proving a load was
   delivered is not the same as proving a POD file exists. Now requires
   `POD_UPLOADED` status *and* a non-null `proofOfDeliveryUrl`.
7. **Partner posting rights were never checked server-side** — a client
   could claim any `partnerOrganizationId` when posting a load. Now verifies
   actual `PartnerMember` membership with `canPostJobs: true` before
   trusting the claim.
8. **Private loads had no invitation mechanism at all** — `PRIVATE_CONFIDENTIAL`
   loads were hidden from every board but had no path to ever be
   successfully requested; the request route unconditionally returned 403.
   Added `CarrierRouteInvitation` (schema), `POST /api/loads/[loadId]/invitations`
   (create + list, poster/admin-only), `POST /api/invitations/[invitationId]/respond`
   (accept/decline, with expiry handling), and wired the load-request route
   to actually check for an ACCEPTED invitation.

**Also fixed alongside these (from the same audit, section 6):**
- `PayoutStatus` renamed `PAID` → `TRANSFERRED`/`PAID_OUT`/`REVERSED` — a
  Stripe Transfer only confirms movement to the worker's Connect balance,
  not confirmed arrival in their bank account. `PAID_OUT` is reserved for
  when Connect payout-completion webhooks are wired (not yet — would need a
  webhook endpoint on the connected account, not just the platform account)
- Connect onboarding no longer trusts a client-supplied email — resolves it
  from the worker's own verified `User` record instead
- Connect callback URLs (`STRIPE_CONNECT_REFRESH_URL`/`RETURN_URL`) are now
  validated at request time with a controlled 500 error instead of a
  non-null assertion that would throw an unhandled exception if unset

**Still open from this audit (P1/P2, not release-blocking per the audit's
own gating):**
- Real Truckstop/DAT adapter implementation, sync scheduling, stale-load
  expiration (P1 — gates external load-board launch, not the Indianapolis
  pilot)
- `ProviderEquipmentMapping` normalization table (P1, same gate — no live
  external provider exists yet to map codes from)
- `resolvePricing()` merging platform → state → market → territory
  `MarketPricingRule` overrides — quotes still use flat global constants
  (P2 — gates multi-market expansion, not the first market)
- Admin market/territory CRUD APIs, consistent `requireMarketAccess()`
  enforcement across all admin routes, geocoding wired into posting flows,
  scheduled FMCSA reverification (P2, same gate)



Implements the adapter architecture from the load-board/payments/carrier
handoff. Honest split: two of the recommended providers (FMCSA, Google Maps)
are public documented APIs with **real client implementations** below;
Truckstop/DAT/123Loadboard/Uber Freight/Direct Freight are commercial APIs
requiring partner agreements I have no verified contract for, so those are
**honest stubs**, not fabricated integrations — see `lib/load-board-adapter.ts`.

**Real, implemented (untested against live endpoints — no network access in
this environment; treat your first real call as the integration test):**
- `lib/fmcsa.ts` — FMCSA QCMobile carrier lookup, upserts a
  `CarrierVerification` row with the raw response, a normalized
  APPROVED/REJECTED decision, and a 30-day expiry. Explicitly a *baseline*
  check — insurance/W-9/Stripe-identity/vehicle verification stay separate.
- `lib/geocoding.ts` — Google Maps Geocoding + Distance Matrix, server-key
  only. Deliberately does not attempt bridge/weight/hazmat truck routing —
  the doc calls for a dedicated commercial truck-routing provider for that,
  which isn't implemented.

**Architecture only (no live provider behind it yet):**
- `lib/load-board-adapter.ts` — the `ExternalLoadBoardAdapter` interface
  exactly as specified, `InternalMarketplaceAdapter` (real — wraps
  TempMovers' own `CarrierRoute` table, no external dependency, always
  available), and stub adapters for Truckstop/DAT/123Loadboard/Uber
  Freight/Direct Freight that throw `AdapterNotConfiguredError` rather than
  pretending to work. Swapping a stub for a real implementation once
  credentials exist shouldn't require touching any call site — only the
  registry.
- `upsertExternalLoad()` — the normalized entry point external providers
  would sync through; enforced at the database level via
  `@@unique([sourceProvider, externalLoadId])` on `CarrierRoute`, so a
  duplicate sync is a no-op upsert, not a new row.
- `EquipmentType` — the fuller taxonomy (box truck by length, reefer,
  flatbed, etc.) as an additive field (`CarrierRoute.detailedEquipmentType`).
  Kept separate from the existing `VehicleType` enum, which drives fee
  calculation in `lib/pricing.ts` — touching that risked breaking working
  pricing logic for a purely descriptive/matching field.

**Acceptance checklist from the handoff, honestly marked:**
- [x] Provider credentials separated by vendor/environment (`.env.example`)
- [x] Secret keys stay server-side (Truckstop/DAT/FMCSA/Google server key
      have no `NEXT_PUBLIC_` prefix)
- [x] Every external load stores provider, external ID, sync status, last-sync
- [x] Duplicate external loads detected before creation (DB unique constraint)
- [x] Customer/shipper PaymentIntent IDs linked to jobs and loads
- [x] Capture gated by completion/POD and server-side authorization
- [x] Every payout has an internal ledger record and Stripe transfer ID
- [x] Stripe Connect status verified before payout
- [x] Webhook signatures and replay protection enabled
- [x] Browser and server map keys have separate restrictions
- [x] Box-truck partner posting works independently of DAT/Truckstop (always
      has — the internal marketplace has no dependency on either)
- [x] Indianapolis enforced as initial controlled-launch market
- [ ] Equipment codes normalized through mapping tables — the taxonomy enum
      exists; a normalization/mapping table from *external* providers' own
      codes isn't built (no real provider to map from yet)
- [ ] FMCSA verification refreshed and audited — the expiry field and
      decision exist; an actual scheduled refresh job isn't built
- [ ] No real Truckstop/DAT/etc. integration — by design, given no verified
      credentials or API contracts (see above)



Country -> State -> Market (`LaunchMarket`) -> Territory -> ZIP/service zone.
Indianapolis is modeled as a `LaunchMarket` (extended, not duplicated — the
KPI-tracking fields that already existed there are unchanged) with two
starter `Territory` rows (Downtown Indianapolis, North Indianapolis/Carmel).

**What's implemented:**
- `LaunchMarket`, `Territory`, `WorkerMarket`, `WorkerTerritory`,
  `PartnerMarket`, `AdminAssignment`, `MarketPricingRule` schema
- `Job` and `CarrierRoute` (freight — with explicit `RouteOrigin`/
  `RouteDestination`/`RouteOriginTerritory`/`RouteDestinationTerritory`
  relation names, since origin and destination both reference the same
  models) carry market/territory/lat-lng context, nullable for now per the
  backfill plan below
- `lib/geo.ts` — `workerCanServeLocation()` / `haversineMiles()`, the single
  source of truth for geo eligibility. Enforced server-side (not just
  filtered client-side) in: `POST /api/jobs/[jobId]/assignments` (job
  acceptance), `GET /api/driver/loads` (load board), and `POST
  /api/loads/[loadId]/request` (load request) — all fail closed: no market
  membership means no visibility/acceptance, not open-by-default
- `lib/market-access.ts` — `requireMarketAccess()`, scoped admin
  authorization (PLATFORM/STATE/MARKET/TERRITORY) so a market manager can't
  implicitly get platform-wide reach
- `prisma/backfill-geo.ts` (`npm run prisma:backfill-geo`) — creates the
  Indianapolis market + territories, backfills existing jobs/routes/worker
  markets/partner markets, and prints an exception report for anything it
  can't confidently assign (non-Indiana freight routes need a human to pick
  the right market)

**Deliberately deferred (P2 — admin UI and pricing inheritance):**
- `MarketPricingRule` resolution/merge logic (platform -> state -> market ->
  territory) is schema-only right now; `lib/pricing.ts` still uses the
  flat, single-market pricing it always has
- `requireMarketAccess()` exists but isn't yet wired into every
  market-scoped admin route — apply the same pattern shown in its own
  doc-comment to `admin/pricing`, `admin/audit-logs`, etc. as market-scoped
  administration becomes necessary
- No admin UI for market/territory CRUD, ZIP assignment, or custom
  boundaries — API/schema only
- Territory inference for existing jobs (from address/ZIP/coordinates) isn't
  automated — no geocoding service is wired in yet, so the backfill script
  leaves `territoryId` null for a human to assign rather than guessing

## Subscription payment UI — mover, driver, and admin portals

The mover and driver "Manage subscription" buttons in `components/DashboardApp.tsx`
were previously dead markup — no `onClick`, no API call. They now call the real
`POST /api/stripe/worker-subscription` endpoint and redirect to the actual
Stripe Checkout session (or show the waiver message if the worker hasn't had
their first completed job yet). The admin portal's subscription numbers were
hardcoded mock values (`$25,616`, `1,284 × $19.95`); they're now a live query
via `GET /api/admin/subscriptions`, with a per-plan breakdown and a worker
table.

**What this required fixing along the way:**
- `WorkerProfile` had no `stripeCustomerId` field — the subscription route
  needed one to charge the worker their own membership fee (distinct from
  `stripeAccountId`, their Connect account for *receiving* payouts). Added
  the field; the route now lazily creates and persists a Stripe Customer for
  the worker on first use, rather than trusting a client-supplied ID.
- The old `POST /api/stripe/mover-subscription` route was unauthenticated
  and trusted a client-supplied `customerId` directly — anyone could have
  billed an arbitrary Stripe customer. Removed it; `worker-subscription`
  now handles all worker plans (mover, driver basic, owner-operator pro,
  fleet) with real auth and a server-resolved customer.
- `lib/client-auth.ts` + `GET /api/me` — minimal token storage/fetch helper
  and a current-user endpoint, since the frontend had no way to know who was
  signed in or attach an auth header to any request.

**Login is now wired.** `components/AuthGate.tsx` provides real sign-in and
account creation forms that call the already-working `POST /api/auth/login`
and `POST /api/auth/register` routes, store the returned JWT via
`lib/client-auth.ts`, and validate it against `GET /api/me` on load. `app/page.tsx`
wraps the dashboard in it, so nothing renders until a real session exists.
The dashboard also now defaults to the signed-in user's own portal (mover
lands on Mover, driver on Driver, admin on Admin) and hides nav items for
portals the user's role can't access — Admin is admin-only, and Customer/
Partner/Mover/Driver are gated to their respective roles (a signed-in Admin
can still see everything, for support purposes). Sign-out is a persistent
button that revokes the session server-side via `POST /api/auth/logout`,
not just a local token clear.

## Driver portal

The driver portal supports:
- Box-truck drivers
- Semi drivers
- Vehicle records
- Registration and insurance expiration
- DOT and MC numbers
- Liftgate/pallet-jack attributes
- Route opportunities
- Settlement/payout visibility

Commercial transportation may require additional carrier, broker, insurance, operating-authority, and state/federal compliance depending on the exact business model.

## Run locally

1. Install Node.js 20+ and PostgreSQL.
2. Copy `.env.example` to `.env`.
3. Fill in the database and Stripe values.
4. Run:

```bash
npm install
npx prisma generate
npx prisma migrate dev --name init
npm run prisma:seed
npm run dev
```

Open `http://localhost:3000`.

## Production work still required

- A negotiated "Request Freight Quotes" workflow for complex box-truck
  jobs and specialized semi freight from approved carriers — entirely new,
  doesn't exist anywhere in this codebase (schema, routes, or UI); the
  existing instant flat-rate flow only covers standard loads
- Admin CRUD for `MarketPricingRule` — the model and resolver
  (`lib/pricing-rules.ts`) exist and are now actually wired into job
  creation/quoting, but there's no admin screen or API route yet to
  create/update rate rules per market; until one exists, rows have to be
  inserted directly
- Detention capture strategy — `calculateDetention()` exists and the
  schema fields are in place, but nothing decides or implements how the
  amount is actually collected (authorized-buffer capture, a supplemental
  PaymentIntent, or separate invoicing); this needs a product decision,
  not just an engineering one
- Before running the `serviceType`/`FreightServiceType` migration against
  any real data: any existing box-truck `CarrierRoute` rows created under
  the old ambiguous `HOURLY` model need to be explicitly classified —
  converted to `FLAT_RATE` using their stored `grossCarrierCents`, or
  marked `CUSTOMER_SUPPLIED_TRUCK_DRIVER_ONLY` — rather than left to
  whatever the schema default happens to assign them
- Wire `PricingRule` into the freight pricing calculators — currently
  neither `calculateSemiLoadQuote` nor the new `calculateBoxTruckLoadQuote`
  read from it; both use hardcoded module constants (pre-existing gap, not
  introduced by the flat-rate freight pay change)
- Mileage-based freight pricing (`loadedMiles`/`deadheadMiles`/
  `estimatedDurationMinutes` driving the customer quote), admin
  pricing-settings UI and driver UI for the new flat-rate/accessorials
  model, and customer checkout copy updates — see "Checkr candidate
  lifecycle..." above for the full scope this was narrowed from
- Automated test suite — no framework (Jest/Vitest/Playwright) is
  configured anywhere in this codebase; the "Reviewed(11)" handoff's
  release-blocker language about proving data-access rules server-side
  implies this is a real prerequisite, not optional
- Authentication and role-based authorization (session/JWT scaffolding exists
  in `lib/auth.ts`; production needs real password/SSO/MFA)
- Request-rate limiting — doesn't exist anywhere in this codebase
- Referral-code capture at registration — `WorkerProfile.referredByWorkerId`
  exists and the referral bonus generators use it, but nothing currently
  sets it; no referral-code field or lookup exists in the signup flow
- `WorkerProfile.completedJobs` isn't incremented for freight/load work,
  only moving-job assignment approval — the driver referral bonus generator
  is wired but can't qualify anyone until this is fixed
- Bonus-award creation business logic (first-job bonus, referral bonus,
  three-5-star bonus) — exists only in the sandbox artifact, never ported
  to the real backend. The ledger accounting and notification wiring for
  awards that exist are now correct; nothing yet creates the awards
  themselves server-side
- A dedicated `PayoutOperation`-based reconciliation worker on a real
  schedule — the model and route-level wiring exist (see "Reviewed(7)
  fixes" above) but nothing runs it proactively; reconciliation currently
  only happens when someone calls the payout endpoint again
- The `/onboarding/driver` frontend wizard beyond what's built — personal/
  business/vehicle/credentials/insurance/DOT-MC/territory/payments/
  subscription all have real forms now; still missing is a more guided,
  linear first-time flow versus the current expandable-sections layout
- Scheduled document-expiration scanning for non-insurance, non-FMCSA
  documents (license, CDL, medical card) — `WorkerDocument.expiresAt`
  exists, insurance and FMCSA now have their own expiration handling
  (Certificial webhook, FMCSA reverification cron), general documents don't
- Duplicate-account prevention beyond email uniqueness (phone, USDOT, MC,
  VIN, Stripe account cross-checks)
- Real Truckstop/DAT (and later 123Loadboard/Uber Freight/Direct Freight)
  API contracts, commercial credentials, and certification —
  `lib/load-board-adapter.ts` has the interface and honest stubs, not live
  integrations; per the launch-integrations handoff, freight should not go
  live until this and FMCSA/insurance/truck-routing are all in place
- A dedicated commercial truck-routing provider for bridge/weight/hazmat
  restrictions — `lib/geocoding.ts` explicitly does not attempt this
- Malware scanning on uploaded documents — infrastructure-level (S3 event +
  scanning service), not expressible as application code here
- Subscription renewal-failure notification — template exists, not wired
  to a trigger yet
- Stripe Dashboard configuration: real Price IDs, Connect enabled, webhook
  endpoint registered (code side is done, this is configuration)
- Market/territory pricing inheritance merge logic and admin CRUD screens
  (schema and eligibility enforcement are done, the pricing resolver and
  admin UI are not)
- `requireMarketAccess()` needs to be wired into the remaining market-scoped
  admin routes beyond the pattern it documents
- Refund, dispute, cancellation, and no-show workflows
- GPS check-in/out and customer PIN
- Admin verification/moderation queue UI (the API routes exist — hide/
  restore/remove reviews, approve/reject documents, worker review — none
  have a dedicated admin frontend beyond what's in the DashboardApp mock)
- Unit, integration, and end-to-end testing
- Legal review for worker classification and transportation operations,
  and separately for the Checkr adverse-action workflow (see "Launch
  integrations" above)

## Driver subscription plans now implemented

- Driver Basic: $29.95/month
- Owner-Operator Pro: $59.95/month
- Fleet: $149/month, including five vehicles
- Additional fleet vehicles: $15/month each
- Box-truck platform fee: $5 per completed route-hour, added to the customer price
- Semi platform fee: 5% of carrier gross, capped at $150 per load, added to the shipper price

The worker subscription endpoint accepts MOVER, DRIVER_BASIC, OWNER_OPERATOR_PRO, and FLEET plans. Fleet checkout can add recurring per-vehicle quantities above five.

## Moving-job revenue rules added

- Scheduled moving jobs: **$5 per approved man-hour**
- Urgent/same-day moving jobs: **$7 per approved man-hour** by default
- Admin-selectable alternative urgent method: **20% urgent premium**
- Customer booking-protection fee: **$9.95 per moving booking**
- Moving projects: minimum **two movers** and **three hours**
- Mover membership: **$19.95/month**, waived until the mover completes the first paid job
- Tips are excluded from platform revenue and should pass 100% to the mover

A minimum scheduled job produces six man-hours and $30 in man-hour fees, plus the $9.95 booking-protection fee. A minimum urgent job using the hourly urgent setting produces $42 in man-hour fees, plus booking protection.


## Partner, launch, and bonus phase

This revision adds partner organizations, multi-location partner records, preferred worker rosters, referral tracking, Indianapolis launch KPIs, private carrier-route visibility, feature flags for regulated freight functions, and one-time bonus programs. Recommended launch bonuses are $25 first-booking credit, $25 after three five-star paid jobs, $50 mover referral after five completed jobs, and $75 driver referral after three completed routes. Bonuses require admin approval and should never be promised merely for signup.

## Status as of this build (10-point checklist)

Honest state, not aspirational:

1. **Frontend port** — Partial. `DashboardApp.tsx` already carries the full visual
   design (7 portals) from an earlier pass. This build added a real `LoadBoard`
   component wired to the live `/api/loads` endpoint in the driver portal. The
   Find Loads/Post a Load/Driver Plans/How It Works sub-tab structure from the
   HTML artifact is NOT yet ported — that UI still only exists in the standalone
   HTML prototype and as backend routes.
2. **Prisma schema** — Finalized for this pass: bonus types split (customer vs.
   mover), 5-level load visibility, `Settlement`, `Session`, verification fields
   on `WorkerProfile`. Never run through `prisma validate` — no network access in
   the build sandbox to fetch the Prisma engine. Review before migrating.
3. **Auth & roles** — Real, not a stub: bcrypt password hashing, revocable JWT
   sessions (`lib/auth.ts`), `requireRole()` guard used on every mutating route
   added in this pass. Login/register/logout routes included. No password reset,
   email verification, or rate limiting yet.
4. **Moving-job & freight-load APIs** — Connected: `/api/jobs` (server-enforced
   2-mover/3-hour floor), `/api/loads` (public, field-stripped GET + authenticated
   POST), `/api/loads/[id]/request` (verification-gated).
5. **Stripe** — Subscription, Connect onboarding, and payment-intent routes were
   already present; this pass extended the webhook to handle payment capture,
   Connect account status, and transfer completion. Untested against a real
   Stripe account — no network access to verify signatures against real events.
6. **Verification** — `/api/workers/[id]/verification` (submit + admin decision)
   added for identity/vehicle/insurance/DOT-MC tracks. No actual document storage
   or third-party verification provider (Checkr, etc.) wired in — that's a real
   external integration, not something fake to demo.
7. **Assignment, timekeeping, POD** — Apply → check-in (GPS) → check-out → customer
   approval → payout creation, plus load status transitions and proof-of-delivery
   upload, are all real routes now with actual state machines.
8. **Referrals, bonuses, partner billing** — `/api/referrals`, the existing
   `/api/bonuses/evaluate` + `/api/admin/bonus-awards/[id]/review`, and a new
   `/api/partners/[id]/billing` monthly rollup are connected.
9. **Admin controls & audit logs** — Pricing controls and bonus review were
   already admin-gated; this pass added `/api/admin/audit-logs` and locked both
   existing admin routes behind `requireRole(["ADMIN"])`.
10. **Testing in the Indianapolis market** — Not done, and can't be done from
    this sandbox: no live Postgres, no deployed app, no real Stripe test-mode
    calls, no real users. `scripts/smoke-test.ts` is a real script that exercises
    auth, pricing floors, public-load field-stripping, and role gating against a
    *running* instance — but it has never actually been executed. Run it
    yourself after `npm install && prisma migrate dev && prisma db seed && npm run dev`.

**What to do before this touches production:** run `npx prisma validate` and
`npx prisma migrate dev`, run `npm run build` and fix whatever TypeScript errors
surface (this was written without a compiler available to check it), get real
Stripe test keys and exercise the webhook with the Stripe CLI, and load-test the
verification gate logic with real documents before trusting it for regulated
freight.

## Phase 4 — Freight Invitations

Builds directly on Phase 3 (Choose Your Helper), which delivered
single-driver load invitations, the worker/driver invitation inboxes,
accept/decline, and customer sent-invitation tracking. Phase 4 adds the
freight-specific *management* layer Phase 3 explicitly deferred: bulk
invitations and reusable invitation message templates.

### New backend

- **`POST /api/loads/[loadId]/invitations/bulk`** — invite up to 25
  drivers to one freight load in a single request. Returns a per-worker
  results array (`{ workerId, ok, error? }`) plus `sentCount` /
  `failedCount`, because a batch legitimately produces mixed outcomes
  ("7 sent, 2 re-invited, 1 driver inactive") that no single HTTP status
  can express. Load-level checks (exists, caller owns it, load open) run
  once up front; per-worker eligibility runs inside the loop.
- **`lib/loads/invite-driver.ts`** — the single source of the
  eligibility → upsert → notify logic for inviting one driver to one
  load. Extracted out of the Phase 3 single-invite route so the single
  and bulk endpoints enforce *identical* rules rather than two
  drifting copies. The Phase 3 route (`POST
  /api/loads/[loadId]/invitations`) was refactored to call it — its
  external contract is unchanged.
- **`lib/loads/invitation-template.ts`** — pure, dependency-free token
  substitution (`{driverName}`, `{loadTitle}`, `{pickupDate}`,
  `{expiresAt}`). In its own file with zero db imports specifically so
  it's unit-testable without a generated Prisma client, the same
  reasoning that put `post-load-schema.ts` in its own file. Unknown
  tokens are left literal, not silently dropped.
- **Invitation templates CRUD** — `GET`/`POST
  /api/invitation-templates` and `PATCH`/`DELETE
  /api/invitation-templates/[templateId]`. Owner-scoped: a customer
  only ever sees, edits, selects, and deletes their own templates.
- **`InvitationTemplate` model** — new. `ownerUserId`, `name`,
  `subject`, `body`, timestamps, `@@index([ownerUserId])`. This is the
  one schema change in Phase 4, so a migration IS required this phase
  (unlike Phase 3, which had none).
- **`customLoadInvitationTemplate`** in `lib/email/templates/booking.ts`
  — renders a customer-authored template into the standard
  `{subject, html, text}` notification shape. Body is HTML-escaped and
  newlines become `<br>`; nothing else in the customer's text is treated
  as markup, so a saved template can't inject arbitrary HTML into an
  outgoing email.

Both the single and bulk invite paths accept an optional `templateId`;
when present the driver's invitation email/in-app notice uses the
rendered template instead of the default `jobInvitationTemplate`.

### New frontend (`DashboardApp.tsx`)

- **Template dropdown** in the existing single-invite modal's driver
  branch (movers/jobs don't get one — templates are freight-only).
- **Bulk-select checkboxes** on the Preferred Network roster, shown only
  for driver-type workers. Selecting one or more surfaces a bulk-invite
  bar: pick a template (optional), choose one of your open loads, send.
  Per-worker failures come back inline against the driver's name.
- **Invitation message templates panel** — full create/edit/delete UI
  for the templates, with the token list documented in-panel.

### Audit & notifications

- Bulk sends write one `LOAD_INVITATION_BULK_SENT` audit entry per batch
  (with requested/sent counts and the succeeded workerIds), not one per
  worker. Single sends keep writing `LOAD_INVITATION_SENT`. Template
  create/update/delete each write their own audit entries.
- Every invited driver is notified (EMAIL + IN_APP) through the existing
  `queueNotification`, reusing Phase 3's per-invitation idempotency key
  so a retried request never double-notifies.

### Verification — static, plus one real unit run

Same standing sandbox limitation as every prior phase: no live Postgres,
no `prisma generate` (no network to fetch the engine), no `npm test`
(can't install vitest), no `npm run build`.

| Check | Result |
|---|---|
| TypeScript syntax check (per-file, TS parser) | 189 files, 0 errors |
| `schema.prisma` brace balance | Balanced |
| Duplicate-declaration scan (new symbols) | 0 duplicates |
| `renderInvitationTemplate` executed under node (transpiled) | 8/8 assertions pass |

The last row is genuine runtime verification — the pure token logic was
transpiled and run, not just read. Everything DB-bound
(`inviteDriverToLoad`, the four new routes, the bulk results shape
against real rows) is static analysis only.

**What this does NOT confirm:** that `Pick<CarrierRoute, ...>` in
`invite-driver.ts` compiles against the real generated Prisma types
(it's a plain top-level model Pick, lower-risk than the
`GetPayload<>` generics flagged in Phase 3.5, but still unverified by a
real compiler here); that the bulk route stays within request timeout
for a full 25-worker batch against a real database; that
`vitest` picks up `tests/loads/invite-driver.test.ts` and passes it in
CI (the logic it tests was verified out-of-band, but the test has never
run under vitest itself).

**Before Phase 4 is production-ready:**
1. `npm ci && npx prisma generate && npx prisma migrate dev` (a
   migration IS needed for `InvitationTemplate` this phase).
2. `npx tsc --noEmit && npm run lint && npm test && npm run build`.
3. Manually: save a template with tokens → bulk-invite 3+ preferred
   drivers to one load using it → confirm each driver receives the
   rendered (not raw-token) message → confirm mixed results surface
   correctly when one selected driver is inactive.

## Phase 5 (backend) — Marketplace Profiles, Reputation & Discovery

Backend-first delivery (frontend is a separate follow-up package, per
the implementation plan). Extends the Phase 1–4 surfaces; adds no
duplicate profile, card, or directory system.

### New models (migration required)

- `Certification` — worker professional certs (issuer, issued/expiry,
  `status`: SELF_REPORTED | VERIFIED | REJECTED). Distinct from `Skill`.
- `WorkerLanguage` — `(workerId, languageCode)` join + proficiency,
  a join (not a String[]) so discovery can filter by language on an index.
- `FavoriteWorker` — a customer's personal, user-scoped bookmark.
  Deliberately separate from Phase 2's partner-scoped `PreferredWorker`.
- `SavedSearch` — a named set of directory filter params (JSON).
  Stores criteria, never a cached result set.

`WorkerProfile` gains `certifications`, `languages`, `favoritedBy`
relations; `User` gains `favoriteWorkers`, `savedSearches`.

### SAFE_WORKER_SELECT

Extended with `bio`, `fiveStarReviewCount`, `profilePhotoUrl`
(display-only — no upload path; that's Phase 5.5), `skills`,
`certifications`, `languages`. Every business-facing worker read still
flows through this one selector — audited by grep across `app/`.

### Shared helpers (pure where it matters, for testability without Prisma)

- `lib/metrics/worker-metrics.ts` — `computeCompletionRate` (definition:
  completed [APPROVED/CHECKED_OUT] ÷ completed + failed [NO_SHOW/CANCELED];
  DECLINED/INVITED excluded; returns null on no data, never 0) and
  `computeMedianResponseMs` (median, not mean). `worker-metrics-db.ts` is
  the DB-fetch wrapper (single + batch). **On-time rate is deliberately
  not implemented** — no expected-arrival field exists, so it's deferred
  rather than shipped as a misleading proxy.
- `lib/discovery/availability-badge.ts` — collapses raw `Availability`
  rows into ONE coarse badge (AVAILABLE_NOW / THIS_WEEK / LATER /
  NO_UPCOMING). The raw calendar is never returned.
- `lib/discovery/worker-directory-filter.ts` — THE shared filter/sort/
  paginate schema, imported by both the directory route and saved-search
  validation, so the two can't drift.
- `lib/discovery/saved-search.ts` — validates saved-search params against
  that shared schema (on save and on replay).
- `lib/discovery/recommendations.ts` — the two transparent rules and
  their displayed `reason` strings. No opaque score.

### Routes

- `GET /api/workers/[workerId]/profile` — EXTENDED: adds `metrics` and
  `availabilityBadge` (skills/certs/languages arrive via SAFE_WORKER_SELECT).
- `GET /api/partners/[partnerId]/worker-directory` — EXTENDED: skill /
  language / minRating / verifiedOnly / acceptingJobsOnly / availability-
  window filters, sort (rating/completedJobs; responseTime falls back to
  rating as it's derived, not a column), pagination, per-page metrics +
  availability badges.
- `GET/POST /api/favorites`, `DELETE /api/favorites/[workerId]`.
- `GET/POST /api/saved-searches`, `GET (replay) / DELETE
  /api/saved-searches/[savedSearchId]`.
- `GET /api/workers/recently-hired` — derived from the caller's own
  assignment history; no new model.
- `GET /api/partners/[partnerId]/recommended-workers` — rule-based,
  each result carries a plain-language reason.

### Two real bugs caught during verification (not shipped)

- `recentlyActive` sort referenced `WorkerProfile.updatedAt`, which
  **does not exist** on that model — removed the sort option rather than
  invent a fake activity timestamp.
- `verifiedOnly` filtered on `identityVerification: "VERIFIED"`, but the
  real "verified" value is `"APPROVED"` (confirmed against the existing
  loads/request check) — fixed. A `"VERIFIED"` filter would have
  silently matched zero workers.

Also corrected a circular market derivation in recommendations to use
the direct `PartnerMarket` relation.

### Verification — static, plus real unit runs

Same sandbox limits (no `prisma generate` / `npm test` / `npm build` —
network disabled).

| Check | Result |
|---|---|
| TypeScript syntax check (per-file) | 203 files, 0 errors |
| `schema.prisma` brace balance | Balanced |
| `SAFE_WORKER_SELECT` grep audit of all `app/` worker reads | All business-facing reads use it |
| `worker-metrics` + `availability-badge` transpiled & executed | 18/18 assertions pass |
| Schema field-name checks (updatedAt, identityVerification, relations) | Done — caught the two bugs above |

**Not runtime-verified:** the four routes' Prisma queries against a real
generated client and DB; the saved-search tests (depend on zod, which
isn't installed here — verified statically only); the migration applying
cleanly. Run `npm ci && npx prisma migrate dev && npm test && npm run
build` before trusting in production.

## Phase 5 (frontend) — Marketplace Profiles, Reputation & Discovery

Extends the existing components; adds NO duplicate profile, card, or
directory. All discovery surfaces render through the one
`WorkerProfileCard`.

### WorkerProfileCard — extended (not replaced)

New OPTIONAL props/fields so every existing caller (Preferred Network,
invite flows) still type-checks and renders unchanged:
- Displays `bio`, `profilePhotoUrl` (display-only), `skills`,
  `certifications` (✓ on VERIFIED), `languages`.
- `metrics` prop → completion % and median response time (rendered only
  when non-null; "no data" simply omits them, never shows 0).
- `availabilityBadge` prop → coarse badge (Available now / this week /
  later / no upcoming).
- `isFavorite` + `onToggleFavorite` → ☆/★ star toggle on the card.

### DashboardApp — directory extended + discovery panels added

- Worker directory: added skill / language / min-rating / verified-only
  / accepting-only filters, sort (rating / completed jobs), and
  Previous/Next pagination driven by the API's `pagination` block.
- Save-search + saved-search chips (apply replays via the saved-search
  endpoint's returned querystring; delete removes).
- New Discovery panel: Favorites, Recently Hired, and Recommended
  (each recommendation shows its plain-language "Why:" reason), all
  rendered with `WorkerProfileCard`, all with working favorite toggles
  and invite actions that reuse the Phase 3–4 invite flow.
- View-profile modal now shows metrics + availability badge from the
  extended profile endpoint.

Because `/api/partners/[partnerId]/preferred-workers` also uses
`SAFE_WORKER_SELECT`, the Preferred Network roster cards gained the new
profile fields for free.

### Verification

Static syntax check: 204 files, 0 errors. Frontend is wired to the
Phase 5 API contracts verified in the backend pass. Not runtime-tested
in a browser here (no build/serve in the sandbox) — exercise browse →
filter → paginate → favorite → save search → recommendations →
invite end-to-end after `npm run build && npm run dev`, per the
handoff's completion criteria.

## Phase 5.5A (frontend) — Portfolio Media UI

Extends the existing DashboardApp views and WorkerProfileCard; no
duplicate card or profile system.

### Worker portfolio dashboard (mover + driver views)

One reusable `renderPortfolioManager()` rendered in BOTH the mover and
driver views (drivers are workers too) — not two copies. Provides:
file-picker upload with progress states running the real presign →
PUT-to-storage → finalize lifecycle (measuring image dimensions
client-side and passing them to finalize), inline edit of title /
display order / primary (radio, approved-only), delete, and status
badges (Draft / Uploading / Pending review / Approved / Rejected /
Removed) with worker-visible rejection reasons. Never renders a raw
storage key or private URL.

### WorkerProfileCard + full profile

- Card gained two OPTIONAL fields — `portfolioPrimaryThumbnailUrl` and
  `portfolioApprovedCount` — rendering an approved primary thumbnail and
  an approved-photo count. Optional, so every existing caller is
  unchanged.
- The profile endpoint now computes these from APPROVED/non-deleted/
  non-removed media only, signing the thumbnail server-side (raw key
  never leaves). Portfolio data was deliberately NOT added to
  SAFE_WORKER_SELECT — that would risk leaking non-approved media into
  every worker read; it's computed in the one profile route instead.
- The View-profile modal shows a responsive, lazy-loaded approved
  gallery (`<ul role="list">` with descriptive alt text, primary
  highlighted). Only approved media appears.

### Admin moderation + reports UI (admin view)

`renderPortfolioModerationPanel()`: a queue with Pending / Approved /
Rejected / Removed / Reported filters, signed preview thumbnails, worker
identity, per-item report counts, and approve / reject (reason
required) / remove / restore actions. Below it, an open-reports queue
with resolve / dismiss (optional note). Private moderation notes are not
shown as worker-visible reasons.

### Verification

Static syntax check: 227 files, 0 errors. Field references in the new
profile-route portfolio query verified against the schema. WorkerProfileCard
confirmed single-definition (no duplicate). Not browser-tested — exercise
upload → pending → approve → public gallery → report → resolve after a
real build. Image upload/finalize depends on real S3 (5.5A) and the
signature/EXIF/thumbnail work remains 5.5B.

## Phase 5.5B — Image Processing & Cleanup Jobs

**Status: ✅ Code Complete · ⏳ Infrastructure Validation Pending.**
Every image-processing and storage-lifecycle feature below requires a real
S3 bucket and the `sharp` native binary. NONE of it has been executed in
the build environment. Do not represent magic-byte detection, EXIF
stripping, dimension/bomb protection, thumbnails, or cleanup jobs as
production-ready until `docs/PHASE-5.5B-VERIFICATION-PLAN.md` has been run
against real infrastructure.

### What's implemented

- `lib/portfolio/image-analysis.ts` — **pure** dimension/megapixel/
  decompression-bomb gates and thumbnail sizing. Fully unit-tested and
  executed (15/15 assertions pass), because it takes metadata rather than
  decoding images.
- `lib/portfolio/image-processing.ts` — `sharp`-based pass: real
  magic-byte signature check, decode + gate, EXIF strip (re-encode without
  metadata, orientation baked via `.rotate()`), and downscaled WEBP
  thumbnail. `sharp` is dynamically imported. **Unverified here.**
- `lib/storage.ts` — added `getObjectBytes` / `putObjectBytes` /
  `buildThumbnailKey` for server-side processing. **Unverified here.**
- `lib/portfolio/feature-flags.ts` — `PORTFOLIO_IMAGE_PROCESSING` flag.
  **Off by default**, so the validated 5.5A flow is byte-for-byte
  unchanged until this is deliberately enabled in a proven environment.
- Finalize integration — when the flag is on, finalize kicks off the
  processing pass out-of-band (never awaited, never affects the 5.5A
  result). When off, finalize is exactly the 5.5A path.
- `app/api/admin/portfolio/[mediaId]/process` — manual/queue processing
  trigger; returns 503 when the flag is off (never pretends to process).
- `lib/portfolio/cleanup-job.ts` + `scripts/portfolio-cleanup.ts`
  (`npm run portfolio-cleanup`) — retention/orphan/removed cleanup and
  `purgeWorkerPortfolio` for account deletion. Eligibility comes from the
  pure, tested `selectCleanupTargets`; deletes are idempotent and
  retry-safe; audit rows are preserved. The physical deletes are
  **unverified here**; there is no scheduler yet (wiring to cron/queue is
  5.5B infra work).

### Added dependency

`sharp ^0.33.5` (native image processing). `npm ci` must install its
platform binary before the flag can be turned on.

### Verification

Static: 234 files, 0 syntax errors; new DB field references checked
against schema. Pure logic executed: 65 portfolio assertions across 5.5A
+ 5.5B (image-analysis, validation, state, cleanup, public-select leak
guard). A boundary bug in the bomb-gate TEST was caught by running it and
fixed (the code was correct; the test's constructed dimensions exceeded
the side limit). Everything sharp/S3-bound remains to be validated per the
5.5B plan.

## Phase 5.5B — Review Corrections (P0/P1)

Applied after the corrected 5.5B review. Status remains ✅ Code Complete ·
⏳ Validation Pending.

- **P0-01 (fixed):** `processPortfolioImage` no longer disables libvips'
  pixel limit. Every sharp pipeline (metadata, re-encode, thumbnail) runs
  with `limitInputPixels: MAX_PIXELS` (40MP), so a decompression bomb is
  refused by the decoder itself; the pure `analyzeImageMeta` gate is now
  defense-in-depth rather than the only guard.
- **P0-02 (fixed):** new `PortfolioProcessingStatus` enum + `processingStatus`
  column. Approval is blocked unless processing is `PROCESSED` (or
  `NOT_REQUIRED` when the feature is off) — enforced by
  `canApproveGivenProcessing` in the moderation action. Unit-tested (5/5).
- **P0-03 (fixed):** finalize no longer fire-and-forgets. It records
  `processingStatus=PENDING` and returns; a durable worker
  (`lib/portfolio/processing-job.ts`, `npm run portfolio-process`) claims
  rows atomically (`PENDING → PROCESSING` via guarded updateMany, so two
  runners can't double-process), processes, and sets `PROCESSED`/`FAILED`.
  No reliance on request lifetime.
- **P0-04 (fixed):** `processPortfolioImage` re-HEADs the object
  (existence + size) immediately before downloading it.
- **P1 (fixed):** the manual process route is restricted to `PENDING`/
  `FAILED` items and uses the same atomic claim; a thumbnail failure now
  returns `ok:false` → `processingStatus=FAILED` (not a false success), so
  it can't be approved.
- **P1 (CANNOT fix in this sandbox — honest limitation):**
  `package-lock.json` sync for `sharp`. Regenerating the lockfile needs
  `npm install`, which the offline sandbox blocks (network 403). This MUST
  be done in the real environment: run `npm install sharp@0.33.5` (or
  `npm ci` after a connected `npm install`) so the lockfile records sharp
  and its native deps before enabling processing.

### Verification of the corrections

234→236 files, 0 syntax errors; schema braces balanced; new
`processingStatus`/`processingError` fields and enum verified against
schema. Pure logic re-run: the P0-02 approval gate passes 5/5, and the
existing 65 portfolio assertions still hold. Everything sharp/S3-bound
(P0-01 decoder behavior, P0-03/P0-04 against a real object, thumbnail
generation) remains for the 5.5B verification plan on real infrastructure.

## Phase 5.5B — Post-review engineering additions

Two recommendations from the final engineering handoff:

### 1. Stale-worker recovery (implemented)

The claim-based worker (P0-03) had a real gap: if a worker claimed a job
(PENDING → PROCESSING) then crashed, the row was stuck in PROCESSING
forever. Fixed:

- `PortfolioMedia` gains `processingStartedAt`, `processedAt`,
  `processingAttempts` (default 0), `lastProcessingAttemptAt`. The claim
  now stamps started-time and increments attempts; success stamps
  processedAt.
- `lib/portfolio/recovery.ts` — PURE decision logic: a PROCESSING row past
  `PROCESSING_TIMEOUT_MS` (20 min) is retried (→ PENDING) if attempts
  remain (< `MAX_PROCESSING_ATTEMPTS` = 3) or marked FAILED otherwise.
  Unit-tested and executed (recovery boundary + selection cases pass).
- `runProcessingRecovery()` in the processing job applies it with guarded
  updates (only if still PROCESSING, so it can't race a live worker), and
  `scripts/portfolio-process.ts` runs recovery before each batch.
- A boundary bug was caught by running the tests (exactly-at-timeout) and
  fixed so "stale" means strictly past the timeout.

### 2. Scheduler wiring (documented, not assumed)

`scripts/portfolio-process.ts` is the idempotent unit of work and is safe
to invoke repeatedly. It documents the wiring options (cron, k8s CronJob,
ECS scheduled task, systemd timer, or a queue worker looping on
`runProcessingBatch`/`runProcessingRecovery`) but deliberately does NOT
assume which mechanism the team uses — connecting it to the real recurring
executor is infra work that can't be done in this repo. Do not rely on
manual execution in production.

### Still pending (unchanged)

`package-lock.json` sync for sharp (needs a connected `npm install`), and
the full 5.5B verification plan against real DB + S3 + sharp. NO-GO for
production stands until those complete.

## Freight fee model — configurable add-vs-deduct (this change)

Business change: freight (semi + owner-operator box-truck loads) moved from
add-on fees to DEDUCT_FROM_PAYOUT so quoted prices match load-board norms
and stay competitive; moving labor and local (customer-supplied-truck)
box-truck jobs remain ADD_TO_CUSTOMER.

- `FeeModel` enum (ADD_TO_CUSTOMER | DEDUCT_FROM_PAYOUT) added.
- `calculateSemiLoadQuote(gross, feeModel=DEDUCT)` and
  `calculateBoxTruckLoadQuote({..., feeModel})` now return explicit
  `customerTotalCents` and `carrierPayoutCents`. In DEDUCT, the posted
  number IS the customer price and the carrier nets price − fee; in ADD,
  the customer pays gross + fee and the carrier keeps the full gross. The
  5%/$150 cap is unchanged and applies in both.
- Storage semantics: `CarrierRoute.grossCarrierCents` now holds WHAT THE
  CARRIER IS OWED (net in deduct, gross in add), and a new
  `CarrierRoute.feeModel` records how the load was priced. Because of this,
  the existing consumers are correct in BOTH models without formula
  changes: settlement pays `sum(grossCarrierCents)` (= carrier net), and
  driver-PI / partner invoices charge `grossCarrierCents + platformFeeCents`
  (= customer total). Verified by an end-to-end simulation using those
  actual formulas.
- Admin-configurable: the fee MODEL is admin-settable per freight service
  type via PUT /api/admin/pricing (`semiFeeModel`,
  `freightBoxTruckFeeModel`) and resolved at posting via
  resolveActivePricingRule. The platform-fee HOURLY RATES and semi
  percent/cap were already admin-editable through the same endpoint
  (`platformFeePerHourCents`, `urgentPlatformFeePerHourCents`,
  `boxTruckFeePerHourCents`, `semiPlatformFeePercent`,
  `semiPlatformFeeCapCents`) and are read by the resolver.

Integrity invariant (verified, both models): platform revenue =
customer charged − carrier paid = the platform fee. 15/15 end-to-end
assertions pass. Requires a migration (FeeModel enum, new columns) and
the usual real-DB/Stripe verification before launch.

## Fee model — alignment with the hybrid-fee handoff

Two changes to match the developer handoff exactly:

- Enum renamed DEDUCT_FROM_PAYOUT → DEDUCT_FROM_PROVIDER across pricing,
  pricing-rules, admin pricing, instant-quote, and the schema.
- CarrierRoute now stores the explicit money breakdown the handoff lists,
  rather than deriving it: grossLoadAmountCents, carrierNetPayoutCents,
  customerTotalCents (alongside the existing grossCarrierCents, which stays
  = carrier net for back-compat, and platformFeeCents). Persisted at load
  creation for both freight service types and the local exception path.
  Stored invariant (verified): customerTotalCents - carrierNetPayoutCents
  == platformFeeCents (+ customer-side accessorials/urgent). 12/12
  field-consistency assertions pass, on top of the earlier 15 end-to-end
  and 21 quote-function assertions.

Still open vs the handoff (not built this pass): the carrier acceptance
screen showing gross → fee → net before accept (handoff P0 UI item — the
load-invitations endpoint returns grossCarrierCents but no fee breakdown),
freight revenue reporting, and live Stripe $0.00-variance reconciliation.
Requires a migration for the FeeModel enum rename + the new columns.

## Accessorial & Additional Charges Engine — P0 core (build steps 1–5)

Implements the approved v3 spec. Steps 1–5 of the 10-step build order are
done; steps 6–10 are scoped below.

### Done
- Schema (step 1): AccessorialType (stable config: shape, platform-share,
  isTaxable+taxRuleCode, ledgerCode/reportingCategory, approval/evidence
  flags), AccessorialMarketPrice (per-market, effective-dated: rate + band
  + version + bandOverride + isPublished), BookingAccessorial (frozen
  snapshot incl. price source + tax/ledger). Enums added; FeeModel-style
  reverse relations on LaunchMarket/Territory/Job/CarrierRoute. Two new
  privileged roles: FINANCE_ADMIN, SUPER_ADMIN.
- Pure calculator (step 2): computeAccessorial() for all 6 shapes (FLAT,
  PERCENTAGE, HOURLY, MILEAGE, PER_ITEM, PER_FLIGHT), platform-share modes
  (flat/percent) with cap + clamp, and isRateWithinBand(). Invariant
  providerShare = customerCharge − platformShare enforced.
- Resolver (step 3): pure resolvePriceRow() (market-specific → national
  fallback, published + effective-at, deterministic by version), pure
  hasOverlap() (half-open ranges), plus DB wrappers resolveAccessorialPrice
  / wouldOverlap.
- Admin CRUD (step 4): catalog create/list; market-price create with band
  validation, overlap rejection, and role-based override (normal ADMIN
  rejected out-of-band; FINANCE_ADMIN/SUPER_ADMIN may override WITH a
  required reason + audit entry). Rows default unpublished.
- Apply (step 5): POST /api/{jobs|loads}/[id]/accessorials — resolve →
  compute → FREEZE snapshot (rate, shape, platform-share, price source
  market/version/effectiveFrom, tax/ledger). Audit on every apply.

### Verification
247 files, 0 syntax errors; all snapshot field references checked against
schema. 33 pure-logic assertions executed and passing (6 shapes, share
modes, cap/clamp, band, resolver market/fallback/effective-date, overlap).
Committed as tests/accessorials/compute.test.ts.

### Remaining (steps 6–10, NOT in this pass)
- Step 6: wire APPROVED accessorial sums into the fee model, customer
  charge (driver-PI / partner invoice), and settlement (provider receives
  base net + sum(providerShareCents)). This edits live payment paths and is
  deliberately deferred to its own focused change.
- Step 7: admin preview (which price row goes live before publishing).
- Step 8: seed ~30 recommended types + national price rows.
- Steps 9–10 (P1): approval workflow + evidence; reporting + reconciliation.
- Migration required (3 models, enums, 2 new roles). Nothing run against a
  real DB. Tax is stored, not computed.

## Accessorial Engine — Step 6 (payment wiring) + reconciliation suite

### Step 6: accessorials wired into the money paths (A-1)
- lib/accessorials/sums.ts — single source of truth for accessorial sums
  (customer charge / provider share / platform share), APPROVED+SETTLED only.
- Customer charge: driver-PI (load payment intent) now adds
  sum(accessorial customerChargeCents) to what the customer authorizes.
- Settlement: provider net now includes sum(providerShareCents) of APPROVED
  accessorials on the settled loads, read from the FROZEN BookingAccessorial
  snapshot (never the live catalog); those accessorials are flipped
  APPROVED -> SETTLED inside the same Serializable transaction, guarded so a
  concurrent settlement can't double-pay them. Mirrors the detention pattern.

### Audit findings addressed
- A-3 (overlap race): AccessorialMarketPrice create now runs its overlap
  check + insert inside a Serializable transaction, closing the read-then-
  write race.
- A-2 (snapshot immutability): no path updates BookingAccessorial cent/
  snapshot fields; settlement changes only status (APPROVED->SETTLED). Full
  DB-level enforcement (column-level) remains a hardening follow-up.

### Reconciliation suite (the production gate)
lib/reconciliation/model.ts + tests/reconciliation/e2e.test.ts encode and
verify the identity, for every completed transaction, INCLUDING accessorials
and refunds:
    Customer Charged - Provider Paid = Platform Revenue      (variance 0)
    Customer Charged - Provider Paid - Platform Net - Stripe Fee = 0
Built from the REAL pricing + accessorial code (not hand-typed numbers), so
any pricing regression surfaces as a non-zero variance. Executed here:
9 scenario assertions PLUS a 500-transaction fuzz (randomized movers, hours,
rates, two accessorial shapes, Stripe fees, periodic refunds) — ALL reconcile
to exactly $0.00 variance on both identities.

Note: the reconciliation MODEL is pure and fully executed. The live-path
wiring (driver-PI total, settlement net) is verified statically + by the
model; confirming it against real Stripe captures and a real settlement run
remains the final pre-production step, per the audit.

## Feature-flag framework + typed integration interfaces (future extension points)

Per the future-development recommendation (Option 2): build clean, isolated
extension points now; defer schema/business logic for each feature until it's
fully specced.

### Built
- Extended the existing FeatureFlag model (did NOT add a parallel table) with
  targeting: status (DISABLED/PILOT/ENABLED), enabledEnvironments/Markets/
  Roles/ServiceTypes/PilotGroups, configuration JSON. All flags default OFF.
- Central gate: lib/feature-flags/evaluate.ts (PURE, unit-tested) + gate.ts
  (DB-backed, FAILS CLOSED — unknown/absent flag or any error => OFF).
  Semantics: DISABLED = hard off; empty targeting list = unrestricted on that
  axis; PILOT requires a pilot-group match; ENABLED honors any set targeting.
- Admin control: PUT/GET /api/admin/feature-flags (privileged roles only,
  audited). GET also surfaces the canonical FUTURE_FEATURE_KEYS not yet
  configured, all effectively DISABLED.
- Typed integration interfaces (lib/integrations/interfaces.ts): AI dispatch,
  route optimization, photo estimation, background checks, insurance
  verification, freight board — CONTRACTS ONLY, no implementations, not
  called anywhere.

### Deliberately NOT built (deferred until each feature is specced)
Placeholder DB tables, fake endpoints, empty UI, partial workflows,
hardcoded future pricing, or any experimental payment/settlement logic.

### Isolation guarantee (verified)
No booking/payment/settlement/reconciliation file imports the flag system —
checked by grep across app/api/settlements, app/api/stripe, jobs/loads
routes, lib/reconciliation, lib/pricing, lib/accessorials. The gate is
advisory and opt-in for FUTURE features only.

### Verification
255 files, 0 syntax errors; schema balanced; 19 pure gate assertions pass
(off-by-default, kill switch, every targeting axis, PILOT, fail-closed).
Requires a migration (FeatureFlag new columns + FeatureFlagStatus enum).
Gate DB wrapper verified statically; pure evaluation fully executed.

## Multi-market authorization — Phase 1: complete the shared helper

Per the Multi-Market Expansion Readiness handoff (P0 #1 and #2). Phase 1
only: make requireMarketAccess() the correct single source of truth. Phase 2
(migrating routes to call it) is intentionally a separate, grouped rollout.

### The gap this closed
lib/market-access.ts existed but (a) was called by ZERO routes and (b) its
STATE-scope branch always returned false, deferring to call sites that never
implemented it — so state-scoped admins effectively had access to nothing.

### Phase 1 changes
- lib/market-access-policy.ts — PURE decision logic for all four scopes:
  PLATFORM (all), STATE (market's state matches assignment, case-insensitive),
  MARKET (exact market), TERRITORY (exact territory only — does NOT grant the
  parent market). Inactive assignments grant nothing.
- lib/market-access.ts — rewritten to be the complete single source of truth:
  it now looks up the market's state itself and evaluates STATE scope
  internally (no call-site logic needed). requireMarketAccess() throws
  (ForbiddenError 403 / MarketNotFoundError 404); added a non-throwing
  checkMarketAccess() for list-filtering.
- tests/market-access/policy.test.ts — 18 assertions across every scope
  combination, all executed and passing.

### Verification
257 files, 0 syntax errors; 18 pure scope assertions pass.

### Phase 2 (NOT done this pass — deliberate)
Migrate market-scoped routes to call requireMarketAccess(), in logical groups
(pricing → settlements → admin → jobs → loads → workers → partners → reports →
accessorial pricing), verifying each group before the next. ~14 route files
reference marketId/originMarketId today and none call the helper yet.

## Multi-market authorization — Phase 2, Group 1: Pricing (migrated)

Following the approved grouped rollout. Group 1 of 9 (Pricing) is migrated to
the centralized helper and verified before proceeding.

### Changes
- lib/market-access.ts: added requireMarketAccessByCode() — resolves a
  marketCode (PricingRule's key) to a LaunchMarket and authorizes against it;
  if no market matches the code (national default like "US-DEFAULT"), requires
  PLATFORM scope. Fail-closed.
- app/api/admin/pricing/route.ts: GET now authenticates AND authorizes market
  access (previously GET had NO auth — a real gap closed); PUT authorizes the
  target market before upserting. No auth logic duplicated in the route — it
  calls the helper. Audit now records actorId + marketCode.

### Verified
257 files, 0 syntax errors. The doc's full regression matrix (8 rows:
PLATFORM / STATE same+diff / MARKET same+diff / TERRITORY same+diff /
inactive) passes against the centralized policy.

### Key finding for remaining groups
Market-scoped routes resolve their market DIFFERENTLY: pricing by marketCode,
jobs by marketId, loads by originMarketId, settlements span MULTIPLE loads
(possibly multiple markets). Phase 2 is therefore per-group design, not a
mechanical replace. Open decision before the settlements group: does settling
a multi-market batch require access to every market in it, or is settlement
platform-scoped? Groups remaining: settlements, admin, jobs, loads, workers,
partners, reports, accessorial pricing.

## Multi-market authorization — Phase 2, Group 2: Settlements (migrated)

Implements the settlement-authorization handoff Option 1: partial settlement
by EXISTING market scope (no new SETTLEMENT_SCOPE permission).

### Changes
- lib/market-access.ts: added partitionByMarketAccess() — splits scoped
  records into authorized vs a per-market skipped summary, using the same
  hasMarketAccess policy. Fails closed: a record with no resolvable market is
  authorized only for PLATFORM scope.
- app/api/settlements/route.ts POST: eligible loads are now partitioned by the
  admin's market authorization inside the Serializable transaction. Only
  authorized loads are settled; detention, accessorials, gross, and the load
  claim all derive from the authorized subset, so skipped loads are fully
  excluded. The response and audit log include skippedMarkets (never silent).
  If eligible loads exist but none are authorized, returns 403 with the
  skipped summary (fail closed).

### Honest gaps vs the handoff
- The doc describes a preview → confirm → REVALIDATE-before-execute flow. This
  route builds+executes in one POST, so authorization is enforced at execution
  (correct and safe), but there is no separate preview endpoint yet. A preview
  route (dry-run returning eligible/skipped without settling) is a clean
  follow-up.
- GET (settlement list) is not yet market-filtered — an admin can still LIST
  settlements across markets; only generation is scoped. List-filtering is a
  small follow-up.

### Verified
257 files, 0 syntax errors. 11 settlement-authorization assertions pass
(full scope matrix + mixed-market batches + combined scopes + fail-closed),
committed as tests/market-access/settlement-partition.test.ts.

### Groups remaining
admin, jobs, loads, workers, partners, reports, accessorial pricing.

## Multi-market authorization — Settlements Option 3: preview + confirm + revalidate

Closes the two gaps left by the earlier settlement migration, per the Option 3
handoff (preview → confirm → revalidate flow, richer skipped summary). Still no
SETTLEMENT_SCOPE permission — deferred to a future financial-role spec.

### Added
- lib/settlements/preview.ts — buildSettlementPreview(): shared, read-only
  summary (eligibleCount, eligibleTotalCents, eligibleLoadIds, skippedCount,
  skippedLoadIds, skippedMarkets, exclusionReason). One source of truth for
  both the preview endpoint and execution.
- POST /api/settlements/preview — dry-run returning the summary + confirmation
  Required flag; audited (SETTLEMENT_PREVIEWED). No settling.
- POST /api/settlements now requires confirm:true (z.literal). Without it →
  428 Precondition Required pointing the caller to run preview first. The
  execution path re-partitions inside the Serializable tx (step 7 revalidation)
  and now returns + audits skippedMarkets AND skippedLoadIds.
- partitionByMarketAccess() accepts a tx client so preview and execution share
  the same policy under the same transaction.

### The 8-step flow (handoff) — status
preview → resolve market/territory → checkMarketAccess → include authorized →
collect skipped → preview summary → require confirmation → revalidate at
execution → audit both. All present. (Territory scope on loads is null for now
since CarrierRoute isn't territory-tagged; market/state/platform fully wired.)

### Verified
260 files, 0 syntax errors. 11 preview-summary assertions (eligible
count/total/IDs, skipped count/IDs/markets, exclusion reason) + the prior 11
partition-matrix assertions all pass. Committed under tests/market-access/.

### Still deferred / follow-ups
- SETTLEMENT_SCOPE dedicated permission (defer until a full financial-role spec).
- Settlement LIST (GET) market-filtering.
- Live DB/Stripe run. Migration for all accumulated phases still required.

## Settlement preview-token binding (TOCTOU protection)

Production enhancement: bind a settlement confirmation to the exact batch the
admin previewed, so records changing between preview and confirmation can't be
silently settled.

### How it works
- lib/settlements/preview-token.ts: computeBatchFingerprint() (PURE) hashes the
  sorted eligible-load projections (id, grossCarrierCents, paymentStatus,
  settlementId) + sorted skipped IDs + worker + period. issuePreviewToken() /
  verifyPreviewToken() wrap it in a short-lived (5 min) signed JWT using the
  existing AUTH_SECRET, so it's stateless — no table or migration.
- POST /api/settlements/preview now returns a previewToken alongside the
  summary (the internal fingerprint projection is stripped from the client
  response).
- POST /api/settlements requires previewToken. It verifies signature + expiry,
  checks the token is bound to this admin/worker/period, then RECOMPUTES the
  fingerprint from current data inside the Serializable transaction and rejects
  with 409 batchChanged if it differs (loads added/removed/re-priced/settled
  elsewhere) or 409 if the token expired.

### Verified
262 files, 0 syntax errors. 9 fingerprint assertions pass (deterministic,
order-independent, and flips on amount/add/remove/status/settled-elsewhere/
skipped-set/period changes). Committed as tests/settlements/fingerprint.test.ts.

### Note
The fingerprint recheck is enforced at execution inside the tx (real
protection). Confirming the full end-to-end preview→execute cycle against a
live DB — including a genuine concurrent modification — is part of the
production-validation testing, not something exercised here.

## Multi-market authorization — Phase 2 complete (admin-scoped routes)

Applied Option 1: market auth only where an ADMIN acts on records they don't
own; customer/worker/partner self-service stays on ownership checks. A full
per-route inventory is in docs/market-authorization-inventory.md.

### Admin-scoped routes now enforcing market access (all 5)
- admin/pricing (Group 1) — marketCode→market, national⇒PLATFORM
- admin/accessorial-prices — marketId, national⇒PLATFORM
- jobs/[jobId]/accessorials — job.marketId (admin-only route), null⇒403
- loads/[loadId]/accessorials — load.originMarketId (admin-only), null⇒403
- settlements (+preview) — per-load partial-by-scope via partitionByMarketAccess

### Owner-scoped routes deliberately unchanged
jobs/loads POST (customer posts own), assignments accept (mover's own), load
request (driver's own), driver/*, partners/[partnerId]/* (partner-scoped).
Adding market auth there would be wrong (actor isn't a market admin) or
redundant with existing ownership checks. See the inventory doc for the full
classification and edge cases (reports = portfolio moderation, not market
scoped; future admin worker/partner mgmt routes must call the helper).

### Verified
263 files, 0 syntax errors. All 5 admin-scoped routes confirmed wired; the
8-row scope regression matrix passes. Engineering standard going forward:
every NEW admin route that resolves a market must call requireMarketAccess.

## Freight external sourcing — DAT adapter (first production load board)

Per the revised direction: make external load sourcing part of the
Indianapolis launch, with DAT as the first production adapter and the internal
board + manual import as REQUIRED fallbacks.

### Built (code)
- lib/integrations/freight-adapters.ts — provider-agnostic adapter interfaces
  (LoadBoardAdapter, EldAdapter, TelematicsAdapter, CarrierVerificationAdapter)
  + registry contract. Plugin pattern: new provider = new adapter file.
- lib/integrations/adapters/dat-adapter.ts — REAL DAT LoadBoardAdapter: auth
  header, request shaping, DAT→ExternalLoad mapping, timeout/error handling.
  Gated by FREIGHT_BOARD_SYNC_DAT flag; inert without DAT_API_BASE_URL +
  DAT_API_KEY.
- lib/integrations/adapters/registry.ts — resolveLoadBoardAdapter() returns an
  adapter ONLY when its flag is enabled AND healthCheck passes; else null →
  callers fall back to internal board + manual import. Never throws.
- app/api/loads/import/route.ts + lib/loads/create-load.ts — manual import
  path (dispatcher transcribes an accepted external load) sharing the SAME
  createCarrierRouteLoad() money path as native posts. Fallback works with no
  external API at all.
- ExternalSyncStatus gains MANUAL_IMPORT; FUTURE_FEATURE_KEYS gains
  FREIGHT_BOARD_SYNC_DAT/TRUCKSTOP/123LOADBOARD, FMCSA/IDENTITY_VERIFICATION,
  ELD_INTEGRATION, GPS_TELEMATICS, FREIGHT_AGENT/BROKER_MODULE — all OFF.
- lib/revenue/categories.ts — inert revenue-category taxonomy for a future
  ledger (no table yet).

### Verified
269 files, 0 syntax errors. 10 DAT-mapping assertions pass (dollars→cents,
incomplete→null, absent rate→undefined). Load-creation refactor preserved
pricing: reconciliation + pricing assertions still green.

### What only YOU / DAT can do (not buildable here)
- DAT commercial agreement + developer access + credentials (DAT_API_BASE_URL,
  DAT_API_KEY). The adapter is inert until these exist.
- DAT certification: the DAT field names in the adapter are PROVISIONAL and
  must be reconciled against the live API during certification before enabling
  the flag.
- The live fetch/auth path is NOT exercised here (no network/credentials) —
  only the pure mapping is tested. Turning the flag on in production is gated
  on certification.

### Sequencing caveat (stated honestly)
Prior handoffs put DAT/Truckstop automation POST-launch; this direction moves
DAT into launch. That makes part of launch readiness depend on DAT's
certification timeline, which is outside your control. The internal board +
manual import remain the guarantee that freight works at launch regardless of
DAT status. Truckstop is a second adapter to add ONLY if its agreement +
certification finish without delaying production validation.

## Admin Integration Health Dashboard

Per launch guidance: give admins one place to see each freight provider's
health as TempMovers adds integrations. Read-only observability; no money path.

### Built
- ProviderAdapter interface extended with optional apiVersion + status()
  (connected, lastSuccessfulSyncAt, lastError/At, credentialExpiresAt).
  Adapters report only what they track.
- lib/integrations/health.ts — PURE assembleHealthRow(): combines flag-enabled,
  timed healthCheck, optional status, and apiVersion into a dashboard row with
  a derived state (DISABLED / CONNECTED / DISCONNECTED / ERROR).
- GET /api/admin/integrations/health — admin-only; for each registered adapter
  runs a timed healthCheck (only when enabled) + optional status(), both
  best-effort behind a timeout so a bad adapter yields an ERROR row, never a
  500. Returns enabled, connected, state, last sync, last error, latencyMs,
  apiVersion, credential expiry.

### Honesty properties (verified)
The dashboard NEVER fabricates health: a disabled provider shows DISABLED with
null sync/error; an unreachable one shows ERROR/DISCONNECTED with the real
error; credential-expired is computed only when a real date exists (absent =
null "not tracked"). 16 assembler assertions pass; tests/integrations/health.test.ts.

### Not built (honest)
The admin UI panel that renders these rows is not built here (backend + data
contract only). Live latency/last-error values require the DAT flag on + real
credentials; until then DAT shows DISABLED, which is correct.

## Integration Health Dashboard — diagnostic enhancements

Added the six troubleshooting fields/actions requested for launch:
- Provider environment (SANDBOX / PRODUCTION) — DAT infers it from its base URL.
- Configuration status (CONFIGURED / MISSING_CREDENTIALS / UNKNOWN).
- Last successful + last failed API response code (adapter-tracked; null until tracked).
- Consecutive failure count (adapter-tracked; null until tracked).
- Manual "Test Connection": POST /api/admin/integrations/test-connection —
  on-demand timed healthCheck + status() for ONE provider, probes even when the
  flag is OFF (so an admin can test creds before enabling), audited, read-only.

ProviderStatus + assembleHealthRow extended; the DAT adapter now implements
status() reporting what it genuinely knows (creds present, environment) and
leaves per-call metrics null until a persistence layer tracks them. Honesty
preserved: every new field is null/UNKNOWN when untracked. 274 files, 0 syntax
errors; health assembler now has 14 assertions incl. the new fields.

Note: per-call metrics (last sync, response codes, consecutive failures) need a
small persistence layer to be populated in production — the fields + contract
are in place; wiring them to a store is a follow-up. The admin UI panel + Test
Connection button remain frontend work.

## Integration Health — separate local config from live network health

Refinement: metadata the adapter can know locally (credentials present?
sandbox vs production? api version) is now gathered REGARDLESS of the feature
flag, so a disabled provider reads e.g. "Disabled · Credentials configured ·
Sandbox" with NO external request. Live network health (healthCheck/status)
still runs only when enabled.

- ProviderAdapter gains configurationStatus(): { credentialsConfigured,
  environment?, apiVersion? } — synchronous, no network.
- DAT adapter implements it (env inferred from base URL); its status() reuses it.
- GET /api/admin/integrations/health calls configurationStatus() for every
  provider unconditionally; healthCheck()/status() stay gated on enabled.
- assembleHealthRow merges local configuration first, then live status, then
  UNKNOWN — honesty preserved (nothing fabricated when neither is present).

274 files, 0 syntax errors; health assembler now 18 assertions incl. the
disabled-but-configured scenario. Not a launch blocker (Test Connection already
gave a pre-enable path); this just improves the at-rest view.

## Integration Health v3 — consistency + efficiency refinements

Two refinements from the v3 handoff, then the backend is frozen for launch.

1. Test Connection consistency: POST /api/admin/integrations/test-connection
   now calls configurationStatus() (local, no network) before the live check,
   so its output matches the GET health endpoint — a disabled-but-configured
   provider shows creds/environment there too. Never fabricates.
2. No duplicate network calls: the DAT adapter's status() no longer calls
   healthCheck() a second time. It returns only adapter-owned metadata
   (credentialsConfigured, environment); the assembler derives `connected`
   from the single live health result the endpoint already ran. Result: ONE
   network request per provider per refresh, not two.

Verified: 274 files, 0 syntax errors; connected still resolves correctly from
live health (CONNECTED/ERROR), disabled-but-configured intact. Backend
Integration Health Dashboard is now feature-complete for launch; remaining
items (admin UI, Test Connection button, persistent historical metrics, live
DAT credential validation) are explicitly NOT launch blockers. Critical launch
gates remain the migration, Stripe test-mode validation, reconciliation, and
end-to-end operational testing.

## Integration Health — thin admin UI panel (read-only)

Per launch guidance: a basic operational view for while the team connects/
certifies DAT. Deliberately thin — no charts, no persisted history, no alerts,
no advanced styling (all post-launch).

- components/IntegrationHealthPanel.tsx — "use client" React component. Fetches
  GET /api/admin/integrations/health via authFetch; renders one card per
  provider with: name, enabled/disabled, status badge (Connected/Disconnected/
  Error/Disabled), environment, credential status, API version, current
  latency, last error, credential expiry, and a Test Connection button
  (POST .../test-connection).
- app/admin/integrations/page.tsx — hosts the panel under /admin/integrations.

TRUTHFULNESS (enforced in the UI, mirroring the backend): null fields render as
"Not tracked"; an unknown-but-enabled field shows "Unknown"; a field that needs
the flag on shows "Unavailable until enabled". No fabricated timestamps or
health. A footnote states historical metrics aren't tracked yet.

Contract verified: every field the panel reads exists in the backend HealthRow
type (the panel surfaces a subset; untracked fields like consecutiveFailures
are intentionally not shown yet). 276 files, 0 syntax errors.

NOTE: this is a React component — it is NOT rendered/tested in a browser here.
It compiles and its data contract matches the API; visual/interaction
verification is part of frontend QA in a running environment. Separate from
booking/payment/settlement/reconciliation.

## Homepage hero copy — Indianapolis launch positioning

Copy + metadata update only. No pricing/booking/payment/settlement/auth logic
touched. Updated the EXISTING hero (components/marketing/TempMoversHero.tsx) —
no duplicate component.

Changes:
- Hero headline → "The Marketplace for Moving Labor, Transportation & Freight".
- Subheadline → approved multi-service copy.
- Eyebrow → new per-market launchEyebrow field in config/markets.ts
  ("Launching in Indianapolis" for Indy; Chicago/national get correct text)
  rather than hardcoding, so multi-market stays honest.
- SEO/OG metadata (app/layout.tsx) → approved title + description; removed the
  stale "nationwide" claim (which conflicted with the Indianapolis-launch
  honesty rule).

Preserved: all design tokens / CSS module / responsive layout; CTA routing
(already goes through onGetStarted → real registration/booking flow, so every
CTA hits a working route); the existing demo-stats gate and the flag-gated
freight CTA label (stays "Post a Freight Load" until the quote flag is on — no
implication that DAT/external boards are live).

Static acceptance criteria met: exactly one H1 (hero), H2 section headings, no
premature third-party-integration claims, no provider logos, 276 files 0
syntax errors. NOT verifiable here (needs staging browser QA): desktop/mobile
hero rendering without clipping/wrapping, and visual heading hierarchy — these
are explicit acceptance items in the handoff (§10) for browser QA.

## Compliance & feature flags — service separation (launch spec, Phase 1 / Option 3)

Smallest, legally-protective first step: separate moving services from future
freight brokerage so brokerage cannot be used before TempMovers' authority is
active. Nothing here touches the money/booking/settlement paths.

- 8 brokerage flags registered (all OFF): FREIGHT_BROKERAGE_ENABLED (master),
  LOAD_POSTING_ENABLED, CARRIER_LOAD_ACCEPTANCE_ENABLED,
  DISPATCH_SERVICES_ENABLED, DIRECT_SHIPPER_QUOTING_ENABLED,
  CARRIER_PAYMENTS_ENABLED, BROKER_CARRIER_AGREEMENTS_ENABLED,
  RATE_CONFIRMATION_GENERATION_ENABLED.
- lib/compliance/service-separation.ts — single source of truth for the 4-way
  separation (MOVING_LABOR, CARRIER_RECRUITMENT, DISPATCH_SUPPORT live;
  FREIGHT_BROKERAGE inert). assertBrokerageAllowed(capability) throws 403 unless
  the master flag AND the capability flag are both on. Fail-closed on error.
  mayRepresentAsBroker() ties public "authorized broker" claims to the master
  flag. Dispatch support is launch-safe, gated by its own flag (independent of
  the brokerage master).

Verified: 10 compliance-gate assertions pass (master-off disables all; both-on
required; assert throws 403 when off; fail-closed on error; dispatch
independent). 278 files, 0 syntax errors. ISOLATION: nothing imports the gate
yet — it's additive scaffolding future brokerage endpoints will call; launch
flows are untouched and brokerage is inert by construction.

NOTE: turning FREIGHT_BROKERAGE_ENABLED on is a MANAGEMENT action gated on
real-world broker authority + bond + insurance + agreements. The code never
flips it automatically, and building this does not represent TempMovers as an
authorized broker.

## Market Management (launch spec phase 2)

Extends the EXISTING LaunchMarket rather than replacing it. Behind an admin
permission; does not touch the moving-labor money/booking/settlement paths.

### Schema
- MarketStage reconciled to the 7 spec stages (PLANNING, CARRIER_RECRUITMENT,
  COMING_SOON, SOFT_LAUNCH, ACTIVE, PAUSED, CLOSED). SAFE migration in
  prisma/migrations/manual/market_stage_reconcile.sql maps existing rows
  explicitly (PIPELINE→PLANNING, SUPPLY_BUILD→CARRIER_RECRUITMENT,
  CONTROLLED_LAUNCH→SOFT_LAUNCH, EXPANSION_READY→ACTIVE, PAUSED→PAUSED) — NOT a
  drop-and-recreate. Reconcile with the Prisma-generated migration in dev.
- Six per-market service controls (customerBooking/moverRecruitment/
  driverRecruitment/carrierRecruitment/dispatchSupport/freightBrokerage), all
  default false — ACTIVE stage does NOT auto-enable services.
- MarketChangeLog audit model (previousStage/newStage/changedFields/changedBy/
  reason/overrideUsed/timestamp).

### Logic (pure, tested)
- lib/compliance/market-brokerage.ts — the four-condition gate. Brokerage
  allowed ONLY if global master ON + capability ON + market flag ON + permission.
  The market flag can NEVER override global compliance (global checked first).
- lib/markets/activation-readiness.ts — validates ZIP/pricing/min-rules/service/
  payment/support/worker+carrier supply/blockers before ACTIVE; returns blockers.
- lib/markets/readiness-dashboard.ts — shapes real per-market counts into
  supply/demand/platform/performance; untracked metrics stay null ("Not
  tracked"), never faked.
- lib/markets/seed-markets.ts — Indianapolis ACTIVE (only customer market);
  Louisville/Cincinnati/Chicago CARRIER_RECRUITMENT; Columbus/Fort Wayne/Dayton/
  Lexington COMING_SOON; St. Louis PLANNING. Every market freightBrokerage=false.

### API
- GET/PATCH /api/admin/markets — list + update stage/services/config without a
  deploy. Activation→ACTIVE runs the readiness check; blockers require
  override:true + reason (428 otherwise), written to MarketChangeLog.
- GET /api/admin/markets/readiness?marketId= — Launch Readiness Dashboard from
  real DB counts (worker supply by type, completed/open jobs); untracked
  metrics null.

### Verified
285 files, 0 syntax errors; schema balanced. 16 pure assertions (4 brokerage
combiner + 6 activation readiness + 6 dashboard). Field/enum names checked
against schema (primaryMarketId, WorkerType, Job.marketId/status). Compliance
checkpoint (this turn): flags fail-closed default false; no route imports the
brokerage gate; no public broker claim; 10 compliance assertions still pass.

### NOT done here (team / live env)
Merge to production branch; run the consolidated migration (incl. the
MarketStage reconcile + six columns + MarketChangeLog); the Stripe/payment/
settlement/payout/refund REGRESSION suites (require live env — cannot run in
sandbox); admin market-management UI + activation confirmation screen +
readiness dashboard UI (frontend); the 'Optional' worker-recruitment markets
seeded OFF for management to toggle.

## Carrier Onboarding (launch spec phase 3)

The carrier COMPANY entity (distinct from an individual DRIVER/WorkerProfile).
Carrier recruitment is launch-safe and works while freight brokerage stays
disabled (rule #7).

### Schema
- Carrier (legal name/DBA/EIN/DOT/MC/authority/home terminal/operating radius/
  trucks) with @@unique on dotNumber + mcNumber (duplicate prevention).
  CarrierStatus enum = the 9 spec statuses. NO bank/routing fields — payment is
  a preference + provider reference only (rule #5).
- CarrierDocument (W9/COI/authority/agreement — storageKey only, file in S3),
  CarrierInsurancePolicy (auto-liability/cargo/general, expiresAt),
  CarrierEquipment, CarrierLane, CarrierAgreement (DISPATCH launch-safe /
  BROKER_CARRIER gated), CarrierFmcsaCheck (dated snapshot + raw result +
  checkError — never permanently valid, rule #4), CarrierStatusEvent (audit).
  CARRIER role added.

### Logic (pure, tested — 23 assertions)
- lib/carriers/lifecycle.ts — validated status machine (canTransition/
  assertTransition): a fresh account CANNOT jump to ACTIVE (#1); ACTIVE only
  after APPROVED (#2). evaluateLoadEligibility: ACTIVE + required insurance
  present/unexpired (#2/#3). autoExpireIfInsuranceLapsed → EXPIRED_DOCUMENTS
  when an ACTIVE carrier's required insurance lapses (#3).
- lib/carriers/expiration.ts — classifies expired / expiring-soon (30d) and
  returns only actionable document/insurance items for alerts.
- lib/carriers/fmcsa.ts — runFmcsaCheck stores a dated snapshot + raw result;
  never throws (lookup-failure handling); isFmcsaCheckStale (30d) so FMCSA data
  is re-checkable, not permanently trusted (#4). Gated by FMCSA_VERIFICATION.

### API
- POST/GET /api/carriers/application — carrier self-service; new record starts
  APPLICATION_STARTED and CANNOT self-advance; duplicate DOT/MC → 409.
- GET/PATCH /api/admin/carriers — review queue + status transitions through the
  validated machine (illegal → 409); activating requires load-eligibility
  (insurance valid → else 428); every change audited to CarrierStatusEvent.
- Readiness dashboard now wires REAL carrier metrics (approvedCarriers,
  carriersWithCurrentInsurance) from the Carrier entity.

### Verified
291 files, 0 syntax errors; schema balanced. 23 carrier assertions pass. Field/
enum names checked vs schema. Duplicate DOT/MC blocked at schema + route.

### NOT done here (team / live env / next)
Safe migration against a real test DB (Carrier models + CARRIER role — part of
the consolidated migration); document ownership/access-control testing;
end-to-end carrier application→approval testing; FMCSA provider wiring (adapter
contract exists, no live provider); carrier onboarding UI (frontend). Document
upload uses the existing presign pattern — the carrier-document upload endpoints
+ COI→policy linking UI remain to be wired.

## Launch checklist — separate frontend workstream (tracked, launch-blocking)
Market Management BACKEND is built but the phase is NOT launch-complete until
these ship + are tested: admin market-management page, market activation
CONFIRMATION screen, and the Launch Readiness Dashboard rendering. These remain
launch-blocking and proceed in parallel with backend phases.

## Factoring foundation (Carrier Onboarding — launch-required scope)

Built the factoring foundation NOW so the carrier/payment-routing/document/admin
models don't need redesign later. Scope: foundation now, referral portal next,
live partner integrations later. NO hard-coded factoring-company integrations.

### Schema (5 future-ready models + audit)
- CarrierFactoringProfile — usesFactoring, company name/contact, account
  reference, verificationStatus (NOT_SUBMITTED/PENDING_REVIEW/VERIFIED/REJECTED/
  EXPIRED), verifiedAt + verifiedById. (Replaced the inline factoring fields on
  Carrier.) NO bank credentials.
- PaymentAssignment — remittance routing under a Notice of Assignment
  (remitToName/reference/instructions, noaDocumentId, status). +
  PaymentRoutingAudit (append-only who/what/why for every routing change).
- FactoringDocument — NOA / release / remittance instructions (S3 storageKey),
  effectiveAt + expiresAt + supersededById (expiration/replacement tracking).
- FactoringPartner — DORMANT: referralEnabled defaults false; applicationUrl +
  trackingCode + commission fields; status PROSPECT until agreement signed.
- FactoringReferral — DORMANT: statuses REQUESTED..FUNDED/CANCELED,
  consentTimestamp before any data leaves TempMovers. Gated by the new
  FACTORING_REFERRAL_ENABLED flag (off).

### The payment rule (pure, tested — 6 assertions)
lib/carriers/payment-routing.ts evaluateRemittanceChange: when an ACTIVE
verified Notice of Assignment is in effect, a carrier can NEVER change the
remittance destination directly — it routes to admin review (428). An admin may
change it only WITH supporting documentation. Every attempt (allowed or blocked)
writes a PaymentRoutingAudit row. Unverified/revoked/superseded NOAs don't lock.

### API
- GET/POST/PATCH /api/carriers/factoring — profile (editing resets to
  PENDING_REVIEW) + remittance-change requests under the NOA control.
- GET/PATCH /api/admin/carriers/factoring — verify/reject with date + verifier;
  audited.

### Verified
294 files, 0 syntax errors; schema balanced. NO bank/routing/account fields in
any factoring model (rule). Referral dormant (referralEnabled=false + flag off).
29 carrier assertions total (23 onboarding + 6 payment-routing).

### NOT done here (team / live / next)
Migration (5 factoring models in the consolidated migration); NOA/COI document
upload endpoints + the profile→document linking; the FactoringDocument expiry →
profile EXPIRED auto-transition wiring (logic pattern exists in expiration.ts);
admin partner-management + referral-tracking SCREENS (next phase); carrier-facing
comparison/referral flow (after signed agreements); partner API/webhook
integrations (after a partner provides real technical docs).

## Carrier document / eligibility / expiration / exception workflows

Builds the launch workflows on the carrier + factoring foundation. Referral
stays dormant (FACTORING_REFERRAL_ENABLED off; no partners activated).

### Centralized eligibility service (§3) — the keystone
- lib/carriers/eligibility.ts (PURE computeCarrierEligibility) +
  lib/carriers/eligibility-service.ts (getCarrierEligibility(carrierId,
  capability, marketId)). Returns STRUCTURED { eligible, blockers:[{code,
  message}] }, evaluating: carrier status, required document approvals,
  insurance expiration, FMCSA authorized + staleness, agreement, payment-routing
  review, market eligibility, global + market brokerage flags, admin hold.
  EVERY future load-offer / carrier-assignment endpoint must call this.
  GET /api/admin/carriers/eligibility exposes it.

### Secure document upload (§1)
- app/api/carriers/documents — presign (POST) → client PUTs to PRIVATE bucket →
  finalize metadata (PATCH); download (GET) returns a SHORT-LIVED signed link,
  never a public URL. Reuses lib/storage createUploadUrl/createDownloadUrl.
  Ownership enforced (carrier's own docs; admins any); storage key must match
  the carrier.

### Expiration engine (§2)
- lib/carriers/expiration-batch.ts (PURE processExpiryBatch) — warnings at
  30/14/7/0 days; lapsed required insurance → EXPIRED_DOCUMENTS transition. A
  scheduled job applies results + audits each auto-transition (the cron/apply
  layer is env-side).

### Payment exception queue (§6)
- lib/carriers/payment-exceptions.ts (PURE) — classifies NOA-pending,
  replacement NOA, release, conflicting instructions, expired assignment,
  routing-change requests, blocked direct-payment attempts, missing docs.
  hasBlockingPaymentException() is the payout gate: NO unresolved exception may
  reach payout. GET /api/admin/carriers/payment-exceptions aggregates the queue.

### Readiness dashboard (§7)
- Expanded per-market carrier breakdown: applications, documentsPending,
  underReview, approved, active, suspended, expiredDocuments,
  withCurrentInsurance, fmcsaVerified, factored, pendingNoaReviews — all real
  DB counts. Stripe/waitlist/etc still null ("Not tracked").

### Verified
303 files, 0 syntax errors; schema balanced. 20 new pure assertions (12
eligibility + 4 payment-exceptions + 4 expiration-batch); 49 carrier assertions
total across the phase. Referral dormant; downloads are signed links.

### NOT done here (team / live / next — completion bar §1-§10)
Consolidated migration vs a real test DB; the scheduled expiration JOB (cron)
that applies transitions + sends warnings (pure decision layer built, runner is
env-side); the payout service CONSUMING getCarrierEligibility +
hasBlockingPaymentException (wire when the freight payout path is built);
document ownership/access-control + e2e "verified NOA cannot be bypassed"
testing against a running DB; admin carrier-review UI + carrier onboarding UI +
factoring exception-queue UI (frontend); NOA/release doc→PaymentAssignment
linking. Deferred per instruction: all factoring referral/partner features.

## Freight audit response (P0 corrections)

Applied the P0 findings from the Freight Load Management Audit Handoff, verified
against the actual codebase (the audit's suggested CarrierMember snippet does
NOT match this schema — carrier ownership is Carrier.ownerUserId, one owner per
carrier — so the ownership check was implemented against the real model):

- P0-01 legacy freight bypass: POST /api/loads and POST /api/loads/import now
  call assertBrokerageAllowed("loadPosting") before creating/importing a
  brokered load (403 while disabled).
- P0-02 public board: GET /api/loads returns an empty { comingSoon: true } board
  when loadPosting is disabled, instead of surfacing broker loads.
- P0-03 instant quote: confirmed it is a NON-BINDING price calculator (no
  persistence, no shipper-facing binding quote), matching the audit's allowed
  "limit to estimator" option; left as estimator.
- P0-04 offer ownership: POST /api/freight/offers/accept now verifies the
  authenticated CARRIER owns offer.carrierId (Carrier.ownerUserId) before
  accepting; 403 otherwise. Admins may act on any. Regression test added.
- P0-05/P0-06 (missing operational APIs, migration): acknowledged, still
  outstanding — these are the remaining freight CRUD routes + the consolidated
  migration, which stay on the not-done list.

NOTE: P0-01/02/04 are code-verified (syntax + logic). The gates' RUNTIME
behavior (403s, empty board) still needs live verification against a running DB,
since flag state is DB-backed.

## P0-05 complete: freight operational routes

All remaining freight backend routes built against the actual schema, each with
the full gate stack (brokerage capability + market + role + ownership +
eligibility + idempotency + append-only audit). DORMANT — all brokerage flags
OFF; every route 403s until authority + activation.

- POST/PATCH /api/freight/loads — create (idempotent creationKey) + validated
  status transitions.
- POST/PATCH /api/freight/offers — create (eligibility snapshot) + decline/
  withdraw. Accept is the separate atomic /api/freight/offers/accept.
- POST/PATCH /api/freight/rate-confirmations — generate (after eligibility
  recheck) + acknowledge; versioned.
- POST/PATCH /api/freight/pod — upload and APPROVAL as SEPARATE actions
  (criterion #7).
- POST/PATCH /api/freight/accessorials — request + admin approval (needs
  supporting doc, criterion #8).
- POST /api/freight/invoices — customer invoice (idempotent, unique number).
- POST /api/freight/settlements — settlement PREP (never pays): enforces
  settlement-readiness + payment-exception gate + verified factoring routing.
- GET /api/freight/loads/audit — append-only audit retrieval.

Verified: 316 files, 0 syntax errors; all 8 freight routes gate-checked; freight
pure logic regresses clean. Runtime behavior (403s, transitions) needs live DB.

## P0-06: consolidated migration plan

See docs/P0-06-consolidated-migration-plan.md. The migration FILE is generated
in a DB environment (`prisma migrate dev`) — not hand-written here, since the
sandbox has no DB/network. The doc inventories every new model (25+) and enum
(23+), flags the MarketStage reconcile as the careful step, and gives the
clean-DB + staging-copy + generate + typecheck + build + test sequence.
Acceptance criteria #1-#13 are confirmed at the code level; #14 (migration on a
real DB) and #15 (e2e) require the live environment.

## Frontend Track 1: Market Management + Launch Readiness (admin)

First frontend workstream (launch control). React client components against the
existing admin market APIs; no backend changes.

- components/admin/MarketManagementPanel.tsx + app/admin/markets/page.tsx —
  lists markets (GET /api/admin/markets), edits stage + 6 service controls via
  PATCH without a deploy. Activation to ACTIVE surfaces the 428 readiness
  blockers and requires an explicit override reason before retrying (never
  silently overrides). States plainly that a market's freight-brokerage control
  cannot override the global compliance flags.
- components/admin/LaunchReadinessDashboard.tsx + app/admin/readiness/page.tsx —
  per-market supply/demand/platform/performance + carrier breakdown (GET
  /api/admin/markets/readiness). Null metrics render as italic "Not tracked",
  never zero — honest basis for expansion decisions.

Verified: 320 files, 0 syntax errors; component field names cross-checked
against the actual API response shapes (readiness carriers block, markets PATCH
428+blockers, GET service fields). Follows existing conventions ("use client",
authFetch from @/lib/client-auth, matching IntegrationHealthPanel honesty rules).
NOT verified: browser render + live API round-trip (no server/DB in sandbox) —
needs staging QA. Build order agreed with product: (1) this, (2) Carrier Portal,
(3) Admin Carrier Review, (4) Carrier Recruiting CRM, (5) Freight Ops Console,
(6) Dispatcher Portal, (7) Shipper Portal.

## Carrier Portal backend gap contracts (unblocks the wizard)

Per the Carrier Portal Contract Matrix + gap handoff, built the missing
carrier-facing contracts so every wizard step binds to a real API. All routes
are carrier-scoped (resolveCarrierId → Carrier.ownerUserId) with per-record
ownership checks on PATCH/DELETE.

- GET /api/carriers/eligibility — reuses getCarrierEligibility; enriches each
  {code,message} blocker with a corrective {action} for the dashboard.
- GET/POST/PATCH/DELETE /api/carriers/insurance — CarrierInsurancePolicy CRUD
  (type/insurer/policyNumber/coverageCents/effective/expires). Verification
  stays admin-side.
- GET /api/carriers/fmcsa-status — derives NOT_CHECKED/PENDING/VERIFIED/
  MISMATCH/STALE/REVIEW_REQUIRED/PROVIDER_UNAVAILABLE. A provider outage
  (checkError) returns PROVIDER_UNAVAILABLE, NEVER a rejection (verified, 6/6).
- POST /api/carriers/application/submit — validates required fields, moves
  APPLICATION_STARTED → DOCUMENTS_PENDING, idempotent, audited to
  CarrierStatusEvent (changedById).
- GET/POST/PATCH/DELETE /api/carriers/equipment — CarrierEquipment CRUD.
- GET/POST/PATCH/DELETE /api/carriers/lanes — CarrierLane CRUD.
- POST /api/carriers/agreements/acknowledge — records CarrierAgreement
  sign/acknowledge (active + signedAt + signer). BROKER_CARRIER stays gated.
- POST/PATCH/GET /api/carriers/factoring/documents — NOA/Release/Remittance
  (FactoringDocument) secure upload; short-lived download link; carrier-scoped.

Schema change (needs migration): CarrierDocument gains rejectionReason,
supersededById, supersededAt — backs the REJECTED/SUPERSEDED document states.
Insurance/equipment/lane/agreement/FMCSA models already existed, so those are
route-only (no migration).

Verified: 329 files, 0 syntax errors; field names checked against schema (caught
+ fixed CarrierStatusEvent.changedById, not actorId); FMCSA outage logic tested.
Runtime behavior needs live DB. NEXT: build the Carrier Portal wizard + dashboard
against these now-complete contracts.

## Carrier Portal: wizard + dashboard (Track 2)

Built against the completed carrier contracts. Client convention: "use client",
authFetch, carrier-scoped endpoints only.

Wizard (components/carrier/CarrierApplicationWizard.tsx + CarrierWizardSteps.tsx,
app/carrier/application): 8 steps (Company, DOT/MC, Insurance, W-9 & agreements,
Equipment, Lanes, Factoring, Review). Save-and-resume (scalar upsert + collection
steps persist through their own endpoints); progress %; step validation;
beforeunload unsaved-change warning; server errors surfaced; duplicate DOT/MC
message; final submit → /api/carriers/application/submit (428 shows missing[]);
idempotent resubmit (already-submitted shows current status).

Dashboard (components/carrier/CarrierDashboard.tsx, app/carrier/dashboard): real
status; eligibility blockers rendered with server-provided corrective actions
(never computes eligibility itself); insurance warnings from server dates
(30/14/7/expired banners); FMCSA state (PROVIDER_UNAVAILABLE shows as temporary
service issue, NEVER rejection); documents with REJECTED reason + SUPERSEDED in
history-not-current; equipment/lanes/agreements/factoring summaries; active
payment assignment shown as locked (changes route to admin review).

Document states: MISSING/UPLOADING/PENDING_REVIEW/APPROVED/REJECTED/EXPIRED/
SUPERSEDED (schema now backs REJECTED/SUPERSEDED). Factoring docs use the
dedicated factoring-document workflow, not the carrier-document route.

PRIVACY (verified by grep): no carrier component requests or shows internal risk
notes, brokerage margins, other carriers' data, admin comments, fraud scoring,
internal audit records, or provider credentials — those have no carrier-facing
route.

Verified: 334 files, 0 syntax errors; component field names cross-checked vs all
carrier API response shapes. NOT verified: browser render + live API round-trip —
needs staging QA. STILL OPEN (migration): the three new CarrierDocument fields
(rejectionReason, supersededById, supersededAt) must be in the consolidated
migration and validated live before REJECTED/SUPERSEDED states work end-to-end.

## Admin Carrier Review (Track 3) — backend gaps + UI

Operational counterpart to the Carrier Portal. Found the same pattern of missing
admin contracts and built them first.

Backend gap contracts added:
- GET /api/admin/carriers/[carrierId] — full detail (documents, insurance,
  equipment, lanes, agreements, latest FMCSA, status history, notes) + factoring
  profile + active assignment. (The list GET only had status filter + insurance
  + latest FMCSA.)
- PATCH /api/admin/carriers/[carrierId]/documents — approve / reject (reason
  required) / supersede; sets CarrierDocument.verified / rejectionReason /
  supersededById+supersededAt. Mirrors the worker-review pattern.
- GET/POST /api/admin/carriers/[carrierId]/notes — internal admin notes
  (new CarrierNote model). Admin-only; no carrier-facing route reads it.
- POST /api/admin/carriers/[carrierId]/refresh-fmcsa — runs runFmcsaCheck (never
  throws; outage → checkError, never a rejection), persists a dated snapshot.

UI (components/admin/CarrierReviewQueue.tsx + CarrierReviewDetail.tsx,
app/admin/carriers + [carrierId]): review queue by status with FMCSA/insurance
signals (FMCSA outage shown as "provider unavailable", never a fault); detail
workspace with company/authority, FMCSA (+re-check), insurance, documents
(approve/reject with reason), factoring/NOA review, eligibility blockers, status
history, and internal notes.

APPROVE and ACTIVATE are SEPARATE actions, matching the backend: APPROVED =
compliance passed; ACTIVE = eligible for loads (backend only allows ACTIVE from
APPROVED and requires valid insurance → 428). Trying to activate a non-approved
carrier returns 409 and the UI explains it.

Schema changes (need migration): CarrierNote model (new); the three
CarrierDocument fields from the portal work are now actually written by the
document-review route.

Verified: 343 files, 0 syntax errors; detail component field names cross-checked
vs the detail endpoint; approve≠activate confirmed against canTransition rules.
NOT verified: browser render + live round-trip (needs staging QA).

## Carrier Recruiting CRM (Track 4) — recruit-before-brokerage engine

Net-new sales pipeline for recruiting 200+ carriers before brokerage activation.
Prospects are DELIBERATELY separate from Carrier records; conversion links them.
Launch-safe: no brokerage dependency.

Schema (needs migration): CarrierProspect, CarrierRecruitingActivity (append-only
timeline), RecruitingTask; enums RecruitmentStage (13), LeadSource (8),
RecruitmentActivityType (7); RECRUITER role added to UserRole.

APIs (all role-gated to RECRUITER + admins via lib/recruiting/guard.ts):
- GET/POST/PATCH /api/recruiting/prospects — list/create/update; DOT/MC duplicate
  detection (soft warn); stage change logs a STAGE_CHANGE activity.
- GET/POST /api/recruiting/prospects/[id] — detail + timeline; log activity
  (NOTE/CALL/EMAIL/SMS), updates lastContactAt/nextFollowUpAt.
- GET /api/recruiting/prospects/[id]/fmcsa — qualification lookup (does NOT
  persist a CarrierFmcsaCheck); outage → PROVIDER_UNAVAILABLE, never NOT_AUTHORIZED.
- POST /api/recruiting/prospects/[id]/invite — records invitation + advances to
  APPLICATION_SENT (delivery is env-side).
- POST /api/recruiting/prospects/[id]/convert — creates/links a Carrier
  (APPLICATION_STARTED — never skips onboarding), idempotent, sets convertedCarrierId.
- GET/POST/PATCH /api/recruiting/tasks — task/reminder system.
- GET /api/recruiting/dashboard — 200-goal progress, pipeline by stage, follow-up load.

PERMISSION RULE enforced structurally: the CRM models carry NO finance/factoring/
payment/compliance data, and no recruiting route or component references any
(verified by grep). Recruiters literally cannot reach that data through the CRM.

UI (components/recruiting/*, app/recruiting + /dashboard): Kanban pipeline board
(stage move via PATCH), add-prospect with duplicate warning, prospect detail
drawer (contact, append-only timeline, log activity, FMCSA lookup, invite,
convert link), recruiting dashboard (200-carrier progress bar, pipeline
distribution, overdue follow-ups).

Verified: 357 files, 0 syntax errors; dashboard math + FMCSA lookup mapping
tested (10/10); permission isolation + field names checked. NOT verified: browser
render + live round-trip (staging QA). MIGRATION LIST now: CarrierDocument
rejectionReason/supersededById/supersededAt, CarrierNote, + recruiting models
(CarrierProspect/CarrierRecruitingActivity/RecruitingTask) + RECRUITER role +
3 recruiting enums.

## Freight Operations Console (Track 5) — admin surface over the dormant freight backend

Built against the freight contracts; every brokered action stays blocked until
the brokerage flags + market + permission + eligibility all pass. Console is
admin-only (RECRUITER excluded).

Read contracts added (admin-gated, NOT brokerage-gated so the console stays
usable for config/test data while dormant; each returns brokerageActive so the
UI can disable production actions):
- GET /api/freight/loads/list — filterable load list + brokerageActive.
- GET /api/freight/loads/[loadId] — full detail (stops, offers, rate cons,
  accessorials, invoices, settlements, amendments, audit) + active NOA + flag.
- GET /api/freight/dashboard — real status counts, attention counts (offers
  pending, missing rate con, POD pending, accessorials pending, exceptions),
  cents-derived financial summary + brokerageActive.

UI (components/freight/*, app/admin/freight + /[loadId]): ops dashboard with
dormant banner ("Freight brokerage is not active…"), status-count chips, load
list; 11-tab load workspace (Overview/Stops/Financials/Offers/Dispatch/Rate
confirmation/Documents/Accessorials/Invoice/Settlement/Audit).

Correctness (verified): frontend transition map MIRRORS backend FORWARD/
CANCELABLE/EXCEPTIONABLE exactly → only backend-allowed actions shown; a failed
transition surfaces the backend reason + current status (never forces UI
forward); money display-formatted from server integer cents (no client math —
grep-verified); POD upload≠approval shown as separate states; factoring remit-to
read-only from server active NOA; rate cons versioned with prior versions +
missing-ack warning; accessorials show supporting-doc-required note; settlement
labeled "preparation is not payment"; dormant → action buttons disabled and say
brokerage is off, not a generic error.

Verified: 365 files, 0 syntax errors; transition map match + recruiter exclusion
+ no-money-math + detail field names all confirmed. NOT verified: browser render
+ live round-trip (staging QA). Migration list unchanged (freight schema already
tracked; no new models this track).

## Dispatcher Portal (Track 6) — per-carrier authorization model

New DISPATCHER role + DispatcherCarrierAccess authorization. A dispatcher only
sees carriers that EXPLICITLY granted access; access never piggybacks on admin
permissions.

Schema (needs migration): DISPATCHER role added to UserRole; DispatcherCarrierAccess
(dispatcherId, carrierId, status PENDING/ACTIVE/REVOKED/EXPIRED, permissions[],
grantedById, grantedAt, revokedAt, expiresAt) with @@unique[dispatcherId,carrierId];
enum DispatcherAccessStatus; Carrier.dispatcherAccess reverse relation.

Security core (lib/dispatcher/access.ts): requireDispatcher (DISPATCHER role
only — NOT admin); resolveCarrierAccess(dispatcherId, carrierId, permission?)
throws 403 unless an ACTIVE, unexpired grant carries the permission;
listAccessibleCarrierIds filters to ACTIVE+unexpired. Permission vocabulary:
VIEW_LOADS, RESPOND_TO_OFFERS, UPDATE_LOAD_STATUS, UPLOAD_DOCUMENTS,
VIEW_SETTLEMENT_STATUS, MANAGE_DRIVERS, VIEW_CARRIER_PROFILE — deliberately NO
payment-routing or compliance-approval permission exists.

Routes (all dispatcher data routes resolve access server-side):
- GET /api/dispatcher/carriers — carrier switcher source (only granted carriers).
- GET /api/dispatcher/carriers/[carrierId]/loads — requires VIEW_LOADS.
- GET /api/dispatcher/dashboard — aggregates across accessible carriers only.
- GET /api/dispatcher/loads/[loadId] — requires VIEW_LOADS; operational data only.
- PATCH /api/dispatcher/loads/[loadId]/status — DUAL-GATED: UPDATE_LOAD_STATUS
  permission AND assertFreightAllowed(loadPosting, requireAdmin:false) AND the
  status machine. Operational milestones only (never INVOICED/PAID).
- POST/PATCH /api/dispatcher/access — CARRIER-side grant/revoke (carrier owner or
  admin acting for them; dispatchers cannot self-grant).

UI (components/dispatcher/*, app/dispatcher + /loads/[loadId]): carrier switcher,
dashboard tiles (active/in-transit, today's stops, missing POD, insurance/doc
warnings), per-carrier dispatch board, load workspace (milestone updates,
stops, offers view, rate-con status read-only, settlement status read-only).
Rate-confirmation acknowledgment is NOT offered to dispatchers (binding the
carrier is reserved for the authorized signer). Dispatch-support views are
launch-safe; brokered actions obey the brokerage gate.

Verified: 377 files, 0 syntax errors; access resolver logic tested 11/11
(PENDING/REVOKED/EXPIRED/expired-date/missing-perm all denied; permission vocab
excludes payment/compliance); no-admin-piggyback + server-side-resolution +
no-forbidden-data all confirmed; caught+fixed FreightGateError (not
FreightDisabledError). NOT verified: browser + live round-trip (staging QA).
MIGRATION LIST now: CarrierDocument 3 fields + CarrierNote + recruiting models +
RECRUITER role + DISPATCHER role + DispatcherCarrierAccess + DispatcherAccessStatus.

## Shipper Portal (Track 7 — final frontend) — pricing-privacy read model

Shipper-facing portal. CORE RULE: a shipper sees only their own loads and only
the customer transportation price — never carrier pay, margin, platform revenue,
or fees. Separate shipper-safe read contracts (NOT reused admin responses).

lib/shipper/view.ts: SHIPPER_LOAD_SELECT (customer* fields ONLY — no carrier/
margin/platform field exists in it); toShipperStatus maps 19 internal states →
10 business statuses (REQUESTED/QUOTED/BOOKED/SCHEDULED/IN_TRANSIT/DELIVERED/
COMPLETED/INVOICED/PAID/EXCEPTION); carrierVisibleToShipper hides carrier
identity until DISPATCHED (never during offer shopping — AVAILABLE/OFFERED/
ACCEPTED all show as BOOKED).

Routes (all scoped to shipperUserId === caller):
- GET /api/shipper/loads — own loads, shipper-safe select, mapped status.
- GET /api/shipper/loads/[loadId] — detail; customer price + stops + carrier
  NAME (only when stage allows) + customer-billable accessorials + invoices +
  podAvailable boolean. EXCLUDES carrier rate/margin/offers/eligibility/
  factoring/routing/audit/notes (none selected).
- GET /api/shipper/invoices — own invoices, customer charge fields only.
- GET /api/shipper/dashboard — counts in shipper buckets + open invoices.
- POST /api/shipper/quote-request — DORMANT-SAFE: when directShipperQuoting is
  off, records a NON-BINDING request-for-contact (ShipperQuoteRequest,
  PENDING_CONTACT) — no binding quote, no capacity reservation, no booking.

Schema (needs migration): ShipperQuoteRequest + ShipperQuoteRequestStatus enum.

UI (components/shipper/*, app/shipper + /loads/[loadId]): 9 sections (Dashboard,
Request a shipment, Quotes, Active loads, Delivered loads, Invoices, Support,
Account) + shipment tracking detail (business status, route, customer price
breakdown, carrier name at stage, POD availability, accessorials, invoices).

Verified: 388 files, 0 syntax errors; pricing-privacy grep clean in BOTH routes
and components (no carrier/margin/platform field anywhere shipper-facing);
status mapping tested 8/8 (offer-shopping states hidden as BOOKED, carrier
identity hidden until DISPATCHED); caught+fixed nonexistent FreightDocument model
reference (POD is proofOfDeliveryUrl on FreightLoad → exposed as boolean, not raw
URL). NOT verified: browser + live round-trip (staging QA). ALL 7 FRONTENDS DONE.

## Checkpoint deliverables 3 & 4: N1–N11 negative tests + launch-blocker register

Negative-test suite (tests/permissions/): harness.ts seeds users of each role,
mints REAL sessions via createSession, builds Bearer-authed Requests, and calls
the ACTUAL exported route handlers against the test DB. negative.test.ts covers
N1–N11 exactly:
- N1 recruiter → factoring & settlements = 401/403
- N2 dispatcher → admin carriers = 401/403
- N3 dispatcher (no grant) → carrier loads = 403
- N4 dispatcher VIEW_LOADS only → status update = 403
- N5 Carrier B never sees Carrier A data
- N6 shipper load-detail JSON deep-scanned: NO carrier*/margin/platform/fees keys
- N7 carrier identity hidden while OFFERED; visible once DISPATCHED
- N8 support → settlements = 401/403
- N9 every non-finance role → settlement POST = 401/403
- N10 admin load transition blocked while brokerage flags OFF (403 capability)
- N11 customer/worker/driver → carrier/recruiting/freight = 401/403
Tests assert real status codes + serialized JSON — they fail if a guard is later
weakened. Caught+fixed: settlements exports POST not GET (import corrected).
Requires a migrated, seeded test DB to run (integration, not pure-logic).

Launch-blocker register (TempMovers_Launch_Blocker_Register.docx): single
consolidated register, 24 rows across MIG-00..07, PERM-01..07, INT-01..06
(Stripe/S3/FMCSA/cron/payout/email), E2E-01..03. Fields: ID, Category,
Requirement, Test/Evidence Required, Owner, Environment, Status (PASS/FAIL/
PARTIAL/NOT TESTED), Evidence/Result, Corrective Action, Retest, Production
Blocking. MIG-00 = RESOLVED (re-verify before create-only); everything else
NOT TESTED — nothing PASS on code review alone. 22 prod-blocking rows
outstanding. GO/NO-GO: NO-GO until every Prod-Block=YES row is PASS on clean DB
AND staging copy with brokerage flags OFF.
