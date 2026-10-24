# TempMovers — Developer Handoff

This is the full TempMovers codebase (Next.js 14 / Prisma / PostgreSQL /
Stripe) as of the latest engagement. Read this first.

## Status in one line
Fully WRITTEN across frontend, backend, and database; NOT yet validated
against real infrastructure. Verdict: **GO FOR PRODUCTION VALIDATION**, not
"done". Pure business logic is executed and trustworthy; everything touching a
DB/Stripe/S3 is verified as static code only (263 files, 0 syntax errors) and
has never run here.

## First things to run (in your dev environment)
1. `npm ci`
2. `npx prisma generate`
3. `npx prisma migrate dev` — ONE migration covers this whole engagement:
   FeeModel enum (renamed DEDUCT_FROM_PAYOUT→DEDUCT_FROM_PROVIDER) + new
   CarrierRoute columns; accessorial engine (AccessorialType,
   AccessorialMarketPrice, BookingAccessorial + 4 enums); UserRole gains
   FINANCE_ADMIN + SUPER_ADMIN; FeatureFlag new columns + FeatureFlagStatus
   enum; portfolio stale-worker recovery columns.
4. `npx tsc --noEmit && npm run lint && npm test && npm run build`
5. Then work through **TempMovers_Production_Validation_Checklist.xlsx**.

## What was built this engagement (all in this tree)
- Hybrid freight fee model (add-to-customer vs deduct-from-provider), admin-
  configurable per service type. See lib/pricing.ts, lib/pricing-rules.ts.
- Accessorial & Additional Charges Engine (P0 core + payment wiring):
  lib/accessorials/*, app/api/admin/accessorial-*, app/api/{jobs,loads}/[id]/accessorials.
- End-to-end reconciliation model + tests: lib/reconciliation/*,
  tests/reconciliation/e2e.test.ts (Customer − Provider = Platform, $0.00).
- Multi-market authorization (Phases 1–2): lib/market-access*.ts, applied to
  admin-scoped routes only. See docs/market-authorization-inventory.md.
- Settlement partial-by-scope + preview/confirm/revalidate + fingerprint token:
  app/api/settlements/*, lib/settlements/*.
- Feature-flag framework + typed integration interfaces (all OFF, isolated
  from money paths): lib/feature-flags/*, lib/integrations/interfaces.ts.
- Earlier phases (4, 5, 5.5A, 5.5B): freight invitations, profiles/discovery,
  portfolio media + moderation + image processing + stale-worker recovery.

## Test suites that ACTUALLY RUN (pure logic — trust these)
`npm test` — 21 test files incl. pricing/detention, reconciliation e2e,
accessorial compute+resolver, market-access policy, settlement partition +
preview + fingerprint, feature-flag gate, portfolio recovery. These executed
green here. DB/Stripe/S3 behavior did NOT run here — that's the checklist's job.

## Hard limitations of this delivery
- No migration has been applied. No app build completed. No page rendered in a
  browser. No Stripe transaction fired. No S3 upload performed.
- Tax is STORED, not COMPUTED (accessorial engine).
- Known P1 gaps flagged in the readiness audit: accessorial snapshot
  immutability enforcement, seed of ~30 accessorial types, ZIP-ownership +
  timezone validation, security pass, load/DR testing, freight fee-model
  backfill for pre-existing loads.

## Read next
- `TempMovers_Full_Platform_Production_Readiness_Audit.docx` — where things
  stand, by area, with the GO-FOR-VALIDATION reasoning.
- `TempMovers_Production_Validation_Checklist.xlsx` — 95 executable checks,
  P0/P1/P2, with an evidence-based sign-off gate. This is your path to "done".
