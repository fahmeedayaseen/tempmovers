# TempMovers — Development Team Handoff

**Prepared for:** TempMovers development / deployment team
**Owner / approver:** Carl R. Newborne
**Date:** October 21, 2026
**Status:** Migration checkpoint pending — production is NO-GO until the gates below pass

---

## 0. The one rule that governs everything

**Do not start the production migration, and do not modify the frozen artifact, until the checkpoint passes.** The schema/code target is frozen. Nothing is marked PASS on code review alone — a PASS requires the stated test to have actually run in the stated environment, with captured evidence. This is the discipline that already caught the MIG-00 schema drift; keep it.

Execution happens in two phases, in order:

1. **Phase 1 — Migration / database / security checkpoint**, against the currently frozen codebase.
2. **Phase 2 — UI/UX normalization**, on a new branch, only after Phase 1 is green.

Do not interrupt Phase 1 to fix appearance.

---

## 1. Where things stand

- All seven frontend portals are built and code-verified (Market Management, Carrier, Admin Carrier Review, Recruiting CRM, Freight Ops Console, Dispatcher, Shipper).
- The full backend, database schema, pricing/fee logic, compliance/brokerage gating, and factoring/payment-routing rules are implemented.
- The complete codebase, runbook, and checkpoint documents are packaged in `TempMovers-Staging-Checkpoint-Handoff.zip`.
- **Verified as code only.** None of the frontends have been browser-tested; no migration has run against a real database; no live Stripe/S3/FMCSA validation has happened. Those are this checkpoint's job.
- **Freight brokerage is dormant by law/status.** Broker authority + MC and the BMC-84 bond are still in process. All eight brokerage capability flags stay OFF; the code never auto-flips them.

Frozen-artifact fingerprint (confirm on unzip): `schema.prisma` = **97 models, 85 enums**; **390** TypeScript source files; sha256 of `schema.prisma` recorded in `HANDOFF_README.md` inside the zip.

---

## 2. Phase 1 — Migration / database / security checkpoint

Run these in order against the frozen artifact. Make **no** code/schema/config changes between steps 1–14 — not even "non-functional" ones; any change creates a new artifact boundary and invalidates evidence gathered so far.

1. **Re-verify MIG-00** against the exact `schema.prisma` being migrated, immediately before create-only. Confirm `RECRUITER` and `DISPATCHER` exist in `UserRole`, and `ShipperQuoteRequest` + `ShipperQuoteRequestStatus` exist. Capture the grep output as the evidence string.
2. `npx prisma generate`.
3. `npx prisma migrate dev --create-only` (writes SQL, applies nothing).
4. **Inspect the generated SQL.** Confirm all expected new models/enums/columns are present; confirm **no** `DROP TYPE` on `MarketStage` and **no** `DROP COLUMN`/`DROP TABLE` on `LaunchMarket`, `FreightLoad`, or any table holding production data; confirm new columns are nullable or safely defaulted.
5. **Merge the MarketStage reconciliation** (`prisma/migrations/manual/market_stage_reconcile.sql`) — the transactional `ALTER TYPE ... RENAME VALUE`-style CASE map. Reject any destructive drop-and-recreate of that enum.
6. Apply to a **completely clean database**.
7. **Seed**, then verify all eight brokerage flags are OFF (`FREIGHT_BROKERAGE_ENABLED` master + the seven capability flags). Use test fixtures only; do not enable production brokerage.
8. `npx prisma generate`, then the existing unit/integration suite.
9. Restore a **copy of staging** and apply the **same** migration artifact (do not regenerate).
10. **Compare** pre/post row counts and FK integrity — only intended additive changes allowed; MarketStage rows preserved and correctly remapped.
11. `npx tsc --noEmit`.
12. Production build (`npm run build`).
13. Existing **API integration suite** against the migrated clean DB.
14. **N1–N11 permission suite** (`tests/permissions/negative.test.ts`) against the migrated DB. Attach the actual test results — not the word "PASS."
15. **Only now** update the MIG/PERM rows in the launch-blocker register, from captured evidence.
16. Move into live-integration (INT) and end-to-end (E2E) staging validation.

**Blocker protocol:** if something genuinely prevents execution — stop, document it, fix only that blocker, re-freeze at a new commit SHA, and restart the affected sequence. Nothing else changes.

**Evidence packet (every step):** command, timestamp/commit SHA, environment, exit code, relevant output.

### N1–N11 — must pass against the migrated DB (server-side denial, not a hidden button)

| ID | Test | Expected |
|----|------|----------|
| N1 | Recruiter → factoring / settlements | 401/403 |
| N2 | Dispatcher → admin routes | 401/403 |
| N3 | Dispatcher → non-granted carrier's loads | 403 |
| N4 | Dispatcher with `VIEW_LOADS` only → status update | 403 |
| N5 | Carrier A → Carrier B application/documents | 404/403 |
| N6 | Shipper load response — no carrier-pay/margin/internal pricing fields | fields absent |
| N7 | Shipper → carrier identity before DISPATCHED stage | hidden |
| N8 | Support → settlements / payment routing | 403 |
| N9 | Non-finance/admin role → settlement preparation | 403 |
| N10 | Brokered freight write while flags OFF | 403 capability gate |
| N11 | Customer/Worker/Driver → carrier/recruiting/dispatcher/freight admin routes | 401/403 |

### Live-integration + E2E (staging, after the migration proves out)

- **INT-01 Stripe** — test-mode $0 reconciliation; webhook delivery/signature.
- **INT-02 S3/object storage** — presigned upload/download round-trip, private + expiring, size/type rules.
- **INT-03 FMCSA** — live lookup + simulated outage → `PROVIDER_UNAVAILABLE` (never a rejection).
- **INT-04 Cron** — fmcsa-reverify, authorization-expiry, reconcile-checkr fire; idempotent.
- **INT-05 Payout/Settlement** — prep works but payout execution stays DISABLED while dormant (prep ≠ payment).
- **INT-06 Email/SMS** — delivery via provider.
- **E2E-01** — Shipper → Freight Ops → offer → execution → POD → admin approval → invoice → settlement-prep (flags OFF via fixtures; money integer-cents throughout; every transition audited).
- **E2E-02** — factoring/payment-routing enforcement in-chain (active NOA locks remittance → admin review 428; shipper never sees it).
- **E2E-03** — recruiter → convert → carrier onboarding continuity (no onboarding skip).

---

## 3. Phase 2 — UI/UX normalization (only after Phase 1 is green)

**Do not fold this into the frozen migration artifact.** Once MIG-01–07 and the permission tests are green, cut a **new UI/UX normalization branch** and re-freeze from there.

**The problem:** the project has two inconsistent styling systems. The original platform UI uses the hand-written design system in `app/globals.css` (tokens `--navy`/`--blue`/`--teal`, semantic classes `.shell`/`.sidebar`/`.card`) — that's wired up. The seven newer portals use **Tailwind utility classes**, but **Tailwind is not installed or configured** (no `tailwindcss`/`postcss` in deps, no config, no `@tailwind` directives). So those portals currently render essentially unstyled.

**The work (visual-system consolidation only):**

- Convert the Tailwind utility styling in the newer portal components to the established TempMovers design system in `app/globals.css` (or make a separately approved styling-system decision).
- **Preserve all route calls, data contracts, authentication, permission guards, brokerage feature flags, validation logic, and business behavior.** Touch functional code only if browser QA exposes an actual defect — and handle that as its own scoped item.
- **Decide up front:** extend the design system with the missing shared components (data tables, tab bars, status pills, the carrier-switcher, the multi-step wizard, dormant/empty states) and apply them consistently — rather than styling each screen by hand. This decision determines whether the result is genuinely consistent.
- **Scope ≈ 17 component files** — carrier dashboard/wizard, dispatcher portal/load workspace, shipper portal/tracking, recruiting screens, freight console/load detail, Market Management, Carrier Review, Launch Readiness, and the integration-health panel. Treat it as a formal workstream, not a quick fix.

**Browser QA (the bar — compilation is NOT the bar):**

- Test every role: Customer/Shipper, Worker/Mover, Driver, Carrier, Dispatcher, Recruiter, Support, Admin, Finance Admin, Super Admin.
- Test desktop **and** mobile/responsive widths.
- Test empty, loading, validation-error, permission-denied, success, and failure states — not only happy paths.
- Do not mark UX complete on successful compilation. Every portal gets a real visual review in a browser.

Then re-run typecheck, build, and browser QA. **That commit becomes the staging-deployment candidate.**

**Docs cleanup (do on this branch, not during the frozen checkpoint):** the repo still contains a pre-existing `DEPLOYMENT.md` from earlier phases that may carry stale/VPS-era guidance. Reconcile it against the current authoritative deployment doc (`TempMovers_Vercel_Neon_R2_Deployment_Handoff.md`) — update or delete it — so there is exactly one authoritative deployment doc. This edit was deliberately *not* made during Phase 1, because changing any file inside the frozen artifact would break the freeze over something cosmetic.

---

## 4. Deployment target — Vercel + Neon + R2 (managed stack)

GoDaddy is the **domain registrar / DNS only**. All application, database, and storage infrastructure runs on managed services. Standing up the environment is staging work and **does not touch the frozen artifact** — provision it in parallel while the code stays frozen, then run the Phase 1 migration gate against it. Record environment details in the evidence packet.

> Full detail is in the companion doc **`TempMovers_Vercel_Neon_R2_Deployment_Handoff.md`** (DNS cutover, env-var map, Neon-branch migration mechanics, cron, rollback). This section is the summary.

**Architecture:**

- **Vercel** runs the Next.js app, API routes, and cron — build (`next build` + `prisma generate`), TLS, zero-downtime deploys, preview environments, and rollback are built in. No Nginx / PM2 / Certbot / OS patching.
- **Neon** (managed Postgres) for the database — automated backups, point-in-time recovery, and one-click **database branches** that map directly onto the checkpoint's clean-DB and staging-copy steps.
- **Cloudflare R2** (or AWS S3) for POD/insurance/factoring/carrier documents — private, presigned access; never the app filesystem.
- Stripe, FMCSA, email/SMS, Sentry — external SaaS.
- Three Vercel environments (Development / Preview-Staging / Production), each with its own Neon branch and its own secrets; never share DB, secrets, buckets, Stripe keys, feature-flag state, or callback URLs.

**DNS:** add the domain in Vercel, then point GoDaddy DNS at it (apex `A` + `www` `CNAME` per the values Vercel shows). Vercel auto-issues and renews TLS — **do not** buy GoDaddy SSL.

**Cron caveat:** Vercel Cron handles the light scheduled jobs (FMCSA re-verify, authorization-expiry, reconcile). Long-running/heavy background work — notably the Phase 5.5B image pipeline (Sharp/thumbnails/EXIF) or large settlement batches — exceeds the serverless execution ceiling and belongs on a persistent worker (a small Railway/Render worker alongside Vercel, or hosting the app on Railway/Render). Not a launch blocker for the dormant-freight launch; flag before enabling heavy background processing.

**Ownership reality:** Vercel/Neon/R2 own the infrastructure, backups, and TLS. Your team still owns app config, env vars, migration execution, cron setup, integration validation, testing, monitoring, and release.

---

## 5. Backups, rollback, monitoring

- **Neon** automated backups + point-in-time recovery; confirm the retention window and run at least one documented restore test *before* relying on it.
- Take and verify a recoverable backup/snapshot (or a Neon branch taken just before) the production migration.
- **App rollback** is instant on Vercel — "Promote to Production" on the prior deployment; still record the pre-migration commit SHA. Plan **DB rollback** from the **inspected** migration SQL — do not assume every migration is reversible.
- Define who can halt deployment and trigger rollback.
- Sentry enabled; Vercel logs + analytics; external uptime monitoring on the production URL; alerts for errors, Stripe/webhook failures, and cron-job failures. Document where logs live and how to roll back.

---

## 6. Brokerage flags — keep OFF

All brokerage capability flags remain OFF after deployment until the applicable live validation is complete and the owner authorizes activation through the operational launch process. Role authorization never overrides a disabled brokerage capability. Record the flag states as DB evidence in the register.

---

## 7. Launch-blocker register — single source of truth

Maintain one consolidated register: MIG-00..07, PERM-01..07, INT-01..06, E2E-01..03. Each row carries: **ID, Category, Requirement, Test/Evidence Required, Owner, Environment, Status (PASS/FAIL/PARTIAL/NOT TESTED), Evidence/Result, Corrective Action, Retest Required, Production Blocking (YES/NO).** MIG-00 stays RESOLVED but is reverified immediately before create-only.

---

## 8. Production GO / NO-GO

**NO-GO** if any production-blocking migration, permission, build, database-integrity, or required live-integration item is FAIL, PARTIAL, or NOT TESTED.

**GO** only after: the frozen migration artifact passes **both** the clean-DB and staging-copy gates; N1–N11 pass; production build is green; backups/rollback are verified; brokerage flags confirmed OFF; and the register has no unresolved production blockers.

---

## 9. Final handoff report to owner

At completion, deliver one report: Vercel project + production URL; Node/Next.js/React/Prisma versions deployed; deployed commit SHA; Neon project + production branch (**never the password**); backup/PITR config; R2/S3 bucket summary (no secrets); staging URL; migration identifier applied; clean-branch + staging-copy results; typecheck/build/test results; N1–N11 results; integration-validation results; current feature-flag states; outstanding blockers with owners; rollback/recovery instructions.

---

## Responsibility split

| Party | Responsibility |
|-------|----------------|
| Vercel | App hosting, build, TLS, deploys, rollback within the plan |
| Neon | Managed Postgres — availability, backups, PITR, branching |
| Cloudflare R2 / AWS S3 | Object storage durability and access control |
| GoDaddy | Domain registration / DNS only |
| Development / DevOps team | App config, env vars, Prisma migration execution, cron setup, integration validation, testing, monitoring, release |
| Application owner (Carl) | Production approval after reviewing the blocker register and deployment evidence |
