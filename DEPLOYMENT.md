# TempMovers — Deployment Guide

This guide covers deploying the current build (freight external sourcing + DAT
adapter + Integration Health dashboard + admin panel, on top of the validated
marketplace, accessorial engine, multi-market authorization, and settlement
work). Read HANDOFF.md first for the overall status.

## 0. Status before you deploy
Fully written across frontend/backend/database; the pure business logic is
unit-verified, but nothing here has run against a real DB/Stripe/S3. Deployment
= turning "written" into "confirmed working". The two hard gates below (migration,
Stripe validation) are non-negotiable before production traffic.

## 1. Prerequisites
- Node version matching package.json "engines"; PostgreSQL; Redis (if used by
  your session/cache config); an S3-compatible bucket; Stripe account (test
  mode first).
- Environment variables (set all before boot; the app throws on missing
  AUTH_SECRET):
  - AUTH_SECRET (JWT signing — required)
  - DATABASE_URL (Postgres)
  - STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET (test-mode keys first)
  - S3 / object-storage credentials + bucket
  - Optional, only when enabling DAT later: DAT_API_BASE_URL, DAT_API_KEY
    (leave unset for launch — the adapter is inert without them)

## 2. Install, generate, migrate (P0 GATE #1)
    npm ci
    npx prisma generate
    npx prisma migrate deploy      # prod; use `migrate dev` on a disposable DB first
This single migration covers the whole engagement, including the newest enum
value MANUAL_IMPORT on ExternalSyncStatus, plus the accessorial engine, the
FINANCE_ADMIN/SUPER_ADMIN roles, the FeatureFlag columns + FeatureFlagStatus
enum, the fee-model columns on CarrierRoute, and portfolio-recovery columns.
Confirm it applies with no drift on a throwaway copy BEFORE prod.

## 3. Build & boot
    npx tsc --noEmit
    npm run lint
    npm test              # pure-logic suites must pass (pricing, reconciliation,
                          # accessorials, market-access, settlement, feature flags,
                          # DAT mapping, integration health)
    npm run build
    npm start
Do not proceed if tsc, tests, or build fail. "0 syntax errors" is NOT a
substitute for a green build + test run.

## 4. Stripe test-mode validation (P0 GATE #2)
Work through TempMovers_Production_Validation_Checklist.xlsx, P0 rows first:
charges, captures, refunds, payouts, partner invoices, settlement, and a
$0.00 ledger-vs-Stripe reconciliation. This is the gate that proves the money
flow — it cannot be skipped or inferred from unit tests.

## 5. Feature flags at launch (all OFF by default)
Leave every FUTURE_FEATURE_KEY disabled for Indianapolis, including
FREIGHT_BOARD_SYNC_DAT. Freight runs on the internal load board + manual
import (POST /api/loads/import) with no external dependency.

## 6. Freight external sourcing (DAT) — enable ONLY after certification
1. Complete DAT commercial onboarding + developer access; obtain credentials.
2. Set DAT_API_BASE_URL + DAT_API_KEY. Reconcile the provisional DAT field
   names in lib/integrations/adapters/dat-adapter.ts against the live API.
3. In a staging environment, open /admin/integrations and use "Test Connection"
   to verify the DAT adapter reports Connected in SANDBOX.
4. Only then enable FREIGHT_BOARD_SYNC_DAT (via PUT /api/admin/feature-flags).
The internal board + manual import remain the fallback the whole time.

## 7. Integration Health panel
Admin-only, read-only, at /admin/integrations. Shows each provider's
enabled/disabled state, connection status, environment, credential status, API
version, live latency, last error, and a Test Connection button. It never
fabricates data: fields the backend can't determine locally show "Unknown" or
"Not tracked"; the live-only latency field shows "Unavailable until enabled"
when the provider is disabled. Historical metrics (last sync, response codes,
consecutive failure counts) are NOT persisted yet — a post-launch item.

## 8. Post-launch (P1)
Truckstop / 123Loadboard / ELD / telematics adapters; a persistence layer for
historical integration metrics; the full revenue ledger; freight-agent
automation. None of these gate the Indianapolis launch.

## What is NOT covered here (needs your environment / QA)
- Frontend visual/interaction QA (React components compile + match the API
  contract, but were not rendered in a browser during development).
- Load/performance testing, security pass, backup/restore + DR drill (P1 in the
  readiness audit).
- Live DAT API behavior (untested until credentials + certification).
