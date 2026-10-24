# TempMovers — Vercel + Neon + R2 Production Deployment Handoff

**Prepared for:** TempMovers development / deployment team
**Owner / approver:** Carl R. Newborne
**Date:** October 22, 2026
**Supersedes:** the GoDaddy VPS deployment handoff. GoDaddy now serves **only** as the domain registrar / DNS. All application, database, and storage infrastructure moves to managed services.
**Status:** Migration-gated. Production is NO-GO until the consolidated migration + permission checkpoints pass in the required environments. Hosting choice does not change that.

---

## 0. Why this stack

| Concern | Service | Why |
|--------|---------|-----|
| App / API / runtime | **Vercel** | Built by the Next.js team; `next build` + Prisma, TLS, zero-downtime deploys, preview environments, and rollback are built in. Removes the Nginx / PM2 / Certbot / OS-patching ops burden entirely. |
| Database | **Neon** (managed Postgres) | Automated backups, point-in-time recovery, and one-click **database branches** that map directly onto the checkpoint's "clean DB" and "staging-copy" steps. |
| Object storage | **Cloudflare R2** (or AWS S3) | S3-compatible; holds POD / insurance / factoring / carrier documents. Private, presigned access — never the app filesystem. R2 has no egress fees; S3 is equivalent if you prefer AWS. |
| Domain / DNS | **GoDaddy** | Registrar only. Point DNS at Vercel. No hosting, no SSL purchase (Vercel issues TLS automatically). |
| Payments | **Stripe** | External SaaS, unchanged. |
| External APIs | **FMCSA**, email/SMS provider, **Sentry** | External SaaS, unchanged. |

The migration/security checkpoint is unchanged — this managed stack actually makes it *easier*, because a throwaway database is a Neon branch (a click) rather than a server task.

---

## 1. Environment separation

Three Vercel environments, each with its own secrets and its own Neon database/branch. Never share production-sensitive state.

| Vercel env | App URL | Database | Stripe | Storage | Flags |
|-----------|---------|----------|--------|---------|-------|
| **Development** | preview/local | Neon dev branch | test keys | dev bucket/prefix | all brokerage OFF |
| **Preview (Staging)** | auto per-PR or a fixed staging domain | Neon **staging branch** | test keys | staging bucket/prefix | all brokerage OFF |
| **Production** | tempmovers.com (via GoDaddy DNS) | Neon production branch | live keys (only after Stripe gate passes) | prod bucket | all brokerage OFF at launch |

Separate, at minimum: `DATABASE_URL`, Stripe keys + webhook secrets, storage bucket/credentials, app/JWT/session secrets, email/SMS config, feature-flag state, and all callback/webhook URLs.

---

## 2. DNS cutover (GoDaddy → Vercel)

1. Add the domain in Vercel (Project → Settings → Domains).
2. In GoDaddy DNS, set the records Vercel specifies — typically an `A` record for the apex to Vercel's anycast IP and a `CNAME` for `www` to `cname.vercel-dns.com` (use the exact values Vercel shows; they can change).
3. Vercel provisions and auto-renews TLS. **Do not** buy GoDaddy SSL.
4. Verify HTTPS resolves and HTTP redirects to HTTPS (Vercel does this automatically).
5. Keep GoDaddy's nameservers, or move nameservers to Vercel — either works; records-only is the smaller change.

---

## 3. Environment variables

**Authoritative source is the repo's `.env.example`** — reconcile the exact names against it before entering anything; the list below is the expected shape, not a substitute. Set each in Vercel per-environment (Project → Settings → Environment Variables). Mark secrets as "Sensitive." Never commit real values.

- **Database:** `DATABASE_URL` (Neon pooled connection string for the matching branch; use Neon's pooled endpoint for serverless, and the direct endpoint for migrations if Prisma requires it — Neon documents both).
- **Auth / sessions:** JWT/session secret(s) — strong and unique per environment.
- **Stripe:** publishable key, secret key, webhook signing secret. Test keys everywhere except Production.
- **Object storage (R2/S3):** account/endpoint, access key id, secret access key, bucket name, region.
- **FMCSA:** API key / credentials.
- **Email/SMS:** provider API keys + sender identities (point non-prod at test/sandbox senders so staging can't reach real customers).
- **Monitoring:** Sentry DSN.
- **App:** public base URL / callback URLs per environment.

---

## 4. Deploy flow

1. Connect the Git repo to Vercel. Production tracks `main` (or your release branch); every PR gets a Preview deployment automatically.
2. Build command: Vercel runs `npm install` + `next build`. Add `prisma generate` to the build — either a `postinstall` script (`prisma generate`) or a `build` script of `prisma generate && next build`. Confirm which the repo already uses before changing it (freeze-safe: this is config the team sets at deploy time, not a change to the frozen artifact's source).
3. Record the deployed commit SHA (Vercel shows it per deployment).
4. **Do not** run `prisma migrate dev` against any shared database from the build. Migrations are a controlled release step (Section 5), run deliberately, not on every deploy.
5. Node version: pin it in `package.json` `engines` or Vercel's project setting to the version the app targets.

---

## 5. Database migration gate (unchanged discipline, Neon-native mechanics)

The migration is a controlled release artifact. The 16-step checkpoint runbook still governs — Neon just provides the environments cleanly.

1. **Re-verify MIG-00** against the exact `schema.prisma` being migrated (grep `RECRUITER`, `DISPATCHER` in `UserRole`; `ShipperQuoteRequest` + `ShipperQuoteRequestStatus`). Capture output.
2. `npx prisma generate`.
3. `npx prisma migrate dev --create-only` (writes SQL, applies nothing).
4. **Inspect the SQL.** No `DROP TYPE` on `MarketStage`; no `DROP COLUMN`/`DROP TABLE` on production-data tables; new columns nullable or safely defaulted.
5. **Merge the MarketStage reconciliation** (`prisma/migrations/manual/market_stage_reconcile.sql`) — the transactional `ALTER TYPE ... RENAME VALUE` CASE map. Reject destructive drop-and-recreate.
6. **Clean DB = a fresh Neon branch.** Create a new branch (empty), apply the migration (`prisma migrate deploy`), seed, verify all 8 brokerage flags OFF.
7. `npx prisma generate` + existing unit/integration suite against that branch.
8. **Staging copy = a Neon branch created from the staging branch** (a point-in-time copy, instant). Apply the **same** migration artifact — do not regenerate.
9. **Compare** pre/post row counts + FK integrity on that branch — additive changes only; MarketStage rows preserved and remapped.
10. `npx tsc --noEmit`; production build; API integration suite against the migrated branch.
11. **N1–N11 permission suite** against the migrated test branch. Attach actual results.
12. Only after **both** the clean branch and the staging-copy branch are green is the production migration eligible. Run it against the production branch **after** taking a verified backup/snapshot (Section 7).

**Blocker protocol:** if something blocks execution — stop, document, fix only that blocker, re-freeze at a new commit SHA, restart the affected sequence.

Neon branching advantage: the "clean DB" and "restore a copy of staging" steps become instant branch operations instead of dump/restore, and a bad run is discarded by deleting the branch.

---

## 6. Scheduled jobs (cron)

The app's scheduled routes — FMCSA re-verify, authorization-expiry, Checkr/reconcile — run on **Vercel Cron** (defined in `vercel.json` with a schedule hitting each endpoint). Validate: execution on schedule, idempotency/locking, logging, retry/failure behavior (INT-04).

**One caveat to weigh:** Vercel serverless functions have an execution-time ceiling. The light scheduled triggers are fine. If any job becomes long-running or heavy — notably the **Phase 5.5B image pipeline** (Sharp/thumbnails/EXIF) or large settlement batches — that work belongs on a persistent worker, not a cron-triggered serverless function. Options when you reach that point: a small **Railway/Render worker service** alongside Vercel, or move the whole app to Railway/Render (both run persistent processes). Not a launch blocker for the dormant-freight Indianapolis launch; flag it before enabling heavy background processing.

---

## 7. Backups, rollback, monitoring

- **Neon:** enable automated backups + point-in-time recovery; confirm the retention window. Take and verify a recoverable backup/snapshot **immediately before** the production migration. Run at least one documented restore test before relying on it.
- **App rollback:** Vercel keeps every deployment — "Promote to Production" on the prior deployment is an instant rollback. Record the pre-migration commit SHA regardless.
- **DB rollback:** plan from the inspected migration SQL; do not assume reversibility. A Neon branch taken just before the prod migration is your fast recovery point.
- **Monitoring:** Sentry enabled; Vercel logs + analytics; external uptime monitor on the production URL; alerts for errors, Stripe/webhook failures, and cron-job failures. Document where logs live and how to roll back.
- Define who has authority to halt deployment and trigger rollback.

---

## 8. Permission & security tests (N1–N11)

Unchanged — call the real routes against the migrated Neon test branch; server-side denial, not a hidden button.

| ID | Test | Expected |
|----|------|----------|
| N1 | Recruiter → factoring/settlements | 401/403 |
| N2 | Dispatcher → admin routes | 401/403 |
| N3 | Dispatcher → non-granted carrier's loads | 403 |
| N4 | Dispatcher `VIEW_LOADS` only → status update | 403 |
| N5 | Carrier A → Carrier B application/documents | 404/403 |
| N6 | Shipper response — no carrier-pay/margin fields | fields absent |
| N7 | Shipper → carrier identity before DISPATCHED | hidden |
| N8 | Support → settlements/payment routing | 403 |
| N9 | Non-finance/admin → settlement prep | 403 |
| N10 | Brokered write while flags OFF | 403 capability gate |
| N11 | Customer/Worker/Driver → carrier/recruiting/dispatcher/freight admin | 401/403 |

---

## 9. Brokerage feature flags — OFF

All eight brokerage capability flags stay OFF after deployment until live validation completes and the owner authorizes activation. Role authorization never overrides a disabled brokerage capability. Record flag states as DB evidence in the register.

---

## 10. External integration validation (staging, before production reliance)

| Integration | Required validation | Gate |
|-------------|---------------------|------|
| Stripe | Test-mode $0 reconciliation; webhook delivery/signature; failure handling | Before live payments |
| R2 / S3 | Presigned upload/download round-trip; private + expiring; size/type rules; failure behavior | Before live document workflow |
| FMCSA | Live lookup + simulated outage → `PROVIDER_UNAVAILABLE` (never a rejection) | Before relying on live checks |
| Vercel Cron | Execution, idempotency/locking, logs, retry | Before scheduled automation |
| Payout/Settlement | End-to-end routing, approvals, exception path, audit; execution stays DISABLED while dormant | Before live payout |

Plus the E2E chain: Shipper → Freight Ops → offer → execution → POD → admin approval → invoice → settlement-prep (flags OFF via fixtures); factoring/payment-routing enforcement in-chain; recruiter → convert → onboarding continuity.

---

## 11. UI / Browser QA

Unchanged from the standing plan: **after** the migration checkpoint passes, cut a separate UI/UX normalization branch and re-freeze. Convert the newer portals' Tailwind utility styling to the approved `app/globals.css` design system (Tailwind is not installed/configured, so those portals currently render unstyled) — visual-system consolidation only; preserve all contracts, auth, permission guards, flags, validation, and business logic. Browser-test every role at desktop and mobile widths, across empty/loading/error/denied/success/failure states. Compilation is not the bar.

(On Vercel, each PR's Preview deployment is a natural place to do this browser QA — a live URL per branch, no staging server to stand up.)

---

## 12. Launch-blocker register — single source of truth

One consolidated register: MIG-00..07, PERM-01..07, INT-01..06, E2E-01..03. Each row: ID, Category, Requirement, Test/Evidence Required, Owner, Environment, Status (PASS/FAIL/PARTIAL/NOT TESTED), Evidence/Result, Corrective Action, Retest, Production Blocking. MIG-00 RESOLVED but reverified immediately before create-only. Nothing PASS on code review alone.

---

## 13. Production GO / NO-GO

**NO-GO** if any production-blocking migration, permission, build, DB-integrity, or required live-integration item is FAIL, PARTIAL, or NOT TESTED.

**GO** only after the frozen migration artifact passes both the clean-branch and staging-copy gates, N1–N11 pass, the production build is green, backups/rollback are verified, brokerage flags are confirmed OFF, and the register has no unresolved production blockers.

---

## 14. Handoff report to owner

At completion: Vercel project + production URL; Node/Next.js/React/Prisma versions deployed; deployed commit SHA; Neon project + production branch (never the password); backup/PITR config; R2/S3 bucket summary (no secrets); staging URL; migration identifier; clean-branch + staging-copy results; typecheck/build/test results; N1–N11 results; integration-validation results; current feature-flag states; outstanding blockers + owners; rollback instructions.

---

## Responsibility split

| Party | Responsibility |
|-------|----------------|
| Vercel | App hosting, build, TLS, deploys, rollback within the plan |
| Neon | Managed Postgres — availability, backups, PITR, branching |
| Cloudflare R2 / AWS S3 | Object storage durability and access control |
| GoDaddy | Domain registration / DNS only |
| Development / DevOps team | App config, env vars, migration execution, cron setup, integration validation, testing, monitoring, release |
| Application owner (Carl) | Production approval after reviewing the blocker register and deployment evidence |
