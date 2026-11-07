# Market Pricing Intelligence — Phase 1

**Branch:** `feature/market-pricing-intelligence` (off `feature/model-b-pricing`)
**Status:** Phase 1 — development/staging only. **No production activation, no live payment changes, no proposed rates activated.**
**Authorized by:** Carl R. Newborne, 7 Nov 2026 (Phase 1 only).

This is an **enhancement layer** on Model B. It introduces **no second pricing
or payment engine**. It produces *recommendations* for admin review; it never
sets a live customer price. The authoritative junk price remains the
owner-approved `PricingRule`, read by `resolveJunkMarketPricing()`.

---

## 1. Pricing authority — how the three record types relate

The directive asked this be documented so future work never creates a competing
price source. There are three distinct records; only the first ever bills.

| Record | Scope | Who reads it to bill | Authority |
|---|---|---|---|
| **`PricingRule`** (unique by `marketCode`) | Junk tier/item/surcharge price table (`junkPriceTable`) + junk take-rate/helper-share | `resolveJunkMarketPricing()` → `quoteJunkForMarket()` | **Authoritative. The only junk price that bills.** |
| **`MarketPricingRule`** (by `marketId`, effective-dated) | **Moving-labor** rates (`moverHourlyRateCents`, scheduled/urgent fees, box-truck). **No junk fields.** | moving-labor pricing | Authoritative for moving labor; **unrelated to junk** |
| **`MarketPriceRecommendation`** (new) | Engine's proposed junk price per (market, service level, tier) | **Nothing. Never billed.** | Proposal only, until an admin writes an approval into `PricingRule` |

Supporting the floor math (not a price source): **`PaymentPolicyConfig`** (by
`marketCode`, read by `resolvePaymentPolicy()`) holds the Model B commercial
values — platform fee bps, helper rate, hauler floor, truck allowance, disposal
estimates — and its `carlApprovedAt` is the owner-approval signal the quote
availability gate checks.

**The rule going forward:** `PricingRule` is the single junk price source.
`MarketPriceRecommendation` is a staging area. Approving a recommendation is an
explicit admin action that writes the approved price into `PricingRule`
(Phase 2 admin UI); the recommendation table never short-circuits that.

```
competitor data ─┐
                 ├─▶ MarketPriceRecommendation (PENDING)  ──admin approves──▶  PricingRule (active)  ──bills──▶ customer
cost floor ──────┘        (never bills)                                         (authoritative)
```

## 2. Reuse of the Model B engine

The cost floor is **not** re-derived. `minimumAcceptablePriceCents()` calls the
very function that prices live quotes — `quoteJunkAllocation()` in
`lib/junk/allocation.ts` — with a zero base price and lets the Model B floor
repricing lift it to exactly cover the platform fee, crew pay, internal disposal
estimate, truck allowance and hauler floor. So the intelligence floor can never
drift from what actually bills (acceptance test #4). No allocation, settlement,
fee, or Stripe behaviour is modified.

## 3. Service levels

A new `JunkServiceLevel` enum (`ECONOMY` / `FULL_SERVICE`):

- **ECONOMY** — budget curbside/easy-access pickup, solo hauler. Eligibility is
  enforced (`junkEconomyEligible`): curbside, nothing heavy/stairs/piano/hot-tub,
  no larger than a quarter truck. An ineligible ECONOMY request **throws** — a
  full-service job is never silently downgraded to a cheaper solo price
  (directive §6).
- **FULL_SERVICE** — in-home, heavy items, stairs, larger loads, crews. Uses the
  existing crew logic unchanged.

**Migration safety:** `JunkRemovalDetail.serviceLevel` defaults to
`FULL_SERVICE`, so every pre-existing booking keeps its original pricing and
settlement records. FULL_SERVICE prices exactly as before this change.

A notable finding this surfaces: a **single item under FULL_SERVICE** (2-person,
2-hour minimum) floors at **$178.57**, so the proposed $129 single-item rate is
only sustainable as **ECONOMY/solo** (floor $92.86). Single-item economics are
why the two service levels are necessary.

## 4. Competitor methodology (Phase 1: manual, verified)

Observations are collected manually and recorded with source URL, observation
date, service type, comparable load, advertised price, and a confidence class.
**No scraping; scheduled collection is Phase 2.**

Comparability rules (`normalizeObservation`), directive §3:
- Curbside/economy prices **never** benchmark a full-service job, and vice versa.
- Only all-inclusive comparables (labor **and** disposal included) are used;
  disposal is never stacked onto a competitor rate (§116, no double-count).
- A volume benchmark must match the requested tier; a per-item price is only
  comparable to a single-item job.
- `LOW` confidence (national estimates) and stale observations are **excluded**
  from benchmarking — kept as context only, never treated as verified local quotes.

Honest state of the seed (`lib/junk/seed-competitors.ts`): every row was
**independently re-verified on 2026-11-07** against the competitor's own local
page (see `VERIFICATION_LOG` in that file). The verified benchmarkable points
are **LoadUp Indianapolis $65** (`goloadup.com/indianapolis/`), **Dropcurb
Indianapolis $79** (`dropcurb.com/cost/bulk-junk-removal/indianapolis-in`),
**LoadUp Elkhart $65** (`goloadup.com/junk-removal/in/elkhart/`) and **LoadUp
Granger $79** (`goloadup.com/granger/`) — all curbside single-item, labor +
disposal included. The earlier draft's **invented national full-service
truckload figures were removed** (they were not verified local quotes). There is
therefore no full-service benchmark in the seed; verified **local** full-service
and transfer-station/disposal costs remain an owner blocker (see §7).

## 5. Competitive decision (directive §4, §92)

For a (market, service level, tier): compute the floor, normalize observations,
anchor on the **lowest valid comparable** (the price to beat), aim **3–7% below**
it, but **never below the floor**.

- Target 7% below clears the floor → **RECOMMENDED** at that price.
- Floor lands inside the 3–7% band → **RECOMMENDED** at the floor (deepest
  sustainable discount).
- Only a sub-3% undercut is possible → **FLOOR_CONSTRAINED** (held at floor).
- **Competitor at or below the floor → FLOOR_HELD: the discount is rejected**,
  holding at the approved rate to protect worker pay and the platform share.
  *This is the LoadUp single-item case: $79 < the $92.86 economy floor.*
- No valid benchmark + approved rate → **USE_APPROVED**; + no approved rate →
  **MANUAL_REVIEW**. Missing cost inputs → **NO_FLOOR**.

## 6. Missing/unapproved data handling (directive §5, §94)

`decideJunkAvailability()` gates the quote and booking routes: a market without a
**market-specific** owner-approved policy **and** its **own** active price rule
returns a controlled **MANUAL_REVIEW** state (HTTP 409, `code:
JUNK_PRICING_UNAPPROVED`) instead of quoting from unapproved example amounts; a
ZIP no market serves is **UNAVAILABLE**. The **US-DEFAULT fallback cannot
activate a market** — `resolveJunkMarketAvailability` requires the policy
`source === "market"` with a `carlApprovedAt`, and an exact-market active
`PricingRule` (not a US-DEFAULT row). Proposed rates cannot be activated without
an admin writing them into `PricingRule` (acceptance #10).

### 6a. Approval path — recommendation → PricingRule (the only route to a live price)

`lib/junk/pricing-approval.ts` holds the sole mechanism:
`applyApprovedRecommendationToTable()` folds an **APPROVED** recommendation's
price into the market's `PricingRule.junkPriceTable` tier map. It is a pure
transform with a hard status gate — a PENDING or REJECTED recommendation throws,
and a price below the recommendation's own floor is refused (defence in depth).
It is never called automatically. Flow: engine writes PENDING → admin reviews
and sets APPROVED (Phase 2 UI) → approval action applies the price and stamps the
`PricingRule` active + `carlApprovedAt` → `resolveJunkMarketPricing()` then reads
the approved table, so every live quote and booking is sourced from approved
configuration, never example defaults.

## 7. Outstanding blockers (production-readiness)

1. **Verified local disposal/transfer-station fees** for Marion, St. Joseph and
   Elkhart counties, plus special-item disposal (mattress, tire, appliance,
   e-waste, refrigerant). Model B's placeholder disposal estimates must not be
   treated as verified local cost (directive §7). The floor is only as accurate
   as these numbers.
2. **Verified local FULL_SERVICE benchmarks.** Only LoadUp curbside single-item
   is verified-local today; full-service truckload comparables are national.
3. **South Bend / Michiana `LaunchMarket`** must be created and junk-enabled; MI
   ZIPs (e.g. Niles) need separate coverage/legal validation. Indianapolis
   observations use the existing `INDY` market code.
4. **Owner approval of the candidate rate cards** (Indianapolis / South Bend) —
   still research recommendations, not approved prices.
5. Phase 2: admin approval UI, scheduled compliant data collection, data-freshness
   monitoring, price snapshots/quote expiry, and staging end-to-end + Stripe
   Test Mode checkout.

## 8. Affected files

**New**
- `lib/junk/market-intelligence.ts` — pure engine (floor, normalization, decision).
- `lib/junk/pricing-approval.ts` — the gated recommendation → PricingRule approval transform.
- `lib/junk/seed-competitors.ts` — independently verified observation data + `VERIFICATION_LOG` (shared by seed + tests).
- `prisma/seed-competitors.ts` — idempotent staging seed script (`npm run prisma:seed-competitors`).
- `prisma/migrations/20261107000000_add_market_pricing_intelligence/migration.sql` — additive migration.
- `tests/junk/market-intelligence.test.ts` — acceptance tests.
- `docs/MARKET-PRICING-INTELLIGENCE.md` — this document.

**Changed**
- `prisma/schema.prisma` — `JunkServiceLevel` + competitor/recommendation enums; `JunkRemovalDetail.serviceLevel`; `CompetitorObservation`, `MarketPriceRecommendation` models.
- `lib/junk/pricing.ts` — service-level codes, `junkEconomyEligible`, solo-crew branch, `serviceLevel` on the quote.
- `lib/junk/full-quote.ts` — `serviceLevel` threaded into plan + public quote.
- `lib/junk/request-schema.ts` — `serviceLevel` input (defaults FULL_SERVICE).
- `lib/junk/market-pricing.ts` — `decideJunkAvailability` + `resolveJunkMarketAvailability`.
- `app/api/junk/quote/route.ts`, `app/api/junk/bookings/route.ts` — availability gate.
- `.github/workflows/ci.yml` — run CI on this branch.

## 9. Acceptance test mapping

| Directive acceptance test | Covered by |
|---|---|
| #3 compare equivalent services | `normalizeObservation` tests (economy↔full-service isolation) |
| #4 never undercut the floor | floor tests + decision tests (LoadUp FLOOR_HELD + profitable RECOMMENDED) |
| #5 full amount drives the 30% fee | preserved by Model B (`lib/junk/allocation.ts`); unchanged |
| #6 disposal counted once, never a refundable line | preserved by Model B; unchanged |
| #9 stale/missing data → fallback/review | `decideMarketPrice` (USE_APPROVED / MANUAL_REVIEW / NO_FLOOR) |
| #10 unapproved prices can't activate | `decideJunkAvailability` + recommendation stays PENDING |
| #11 customer input can't override server price | booking route recomputes server-side (unchanged) |
| #14 existing Model B tests still pass | full `tests/junk` + `tests/labor` run in CI |

Service-level eligibility and the availability gate have dedicated tests.
