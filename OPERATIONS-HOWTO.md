# TempMovers — Operations How-To

Written by VASRUE Digital Media, 24 October 2026, as part of the consolidation checkpoint. **Updated 28 October 2026** — sections 1, 2, 5, 7, 8, 9 and 10 now reflect the current state, and section 12 covers junk removal, added the same day.
Every command below has been run against this project. Nothing here is theoretical.

---

## 1. Where things stand

The database now exists. It never did before this checkpoint — the artifact shipped with no migration history at all.

| | |
|---|---|
| Database | Neon, project `frosty-feather-79812865` |
| Branches | `production` (default — migrated and seeded 27 Oct) · `staging` (a copy of `production`, used for testing) · `migration-test` (the checkpoint branch; expires 31 Oct) · `pre-restore-damaged` (kept from the restore test in section 6) |
| Migrations | Four, all additive: `20261024121500_init` (97 tables, 85 enums, 135 foreign keys), two that add the columns the application code already used, and `20261028180000_add_junk_removal` (section 12). The fourth is applied to `staging`; apply it to `production` with `npx prisma migrate deploy` when the app is deployed there |
| App host | Vercel team `tempmovers-team`. `tempmovers.com` serves the holding page. A password-protected test deployment runs against the `staging` branch |
| Documents | Cloudflare R2 — **not provisioned yet** |

The typecheck, the production build, the full test suite and N1–N11 all pass — see sections 5 and 10. What stands between this and a live platform is now the third-party accounts in section 7, not the code or the database.

---

## 2. One-time setup on a new machine

```bash
npm ci                      # never npm install — see section 10
npx prisma generate
```

Create `.env` in the project root. It is gitignored and must never be committed.

```
DATABASE_URL="<direct, unpooled Neon connection string>"
AUTH_SECRET="<at least 32 characters>"
CRON_SECRET="<random>"
NEXT_PUBLIC_APP_URL="http://localhost:3000"
```

Get a connection string with:

```bash
neon connection-string <branch-name> --project-id frosty-feather-79812865 --prisma
```

> **Use the direct endpoint, not the pooled one, for anything that runs migrations.** `schema.prisma` declares no `directUrl`, so Prisma has no way to route DDL around a connection pooler. The app wants the *pooled* URL at runtime. With no `directUrl` in the datasource block there is no way to have both at once without a schema change — worth resolving before production.
>
> On Windows, `neon connection-string ... > .env` writes **UTF-16**, which dotenv cannot read. Convert to UTF-8 or paste the value in by hand.

`.env.example` lists all 73 variables the full application expects. The four above are enough for database and test work.

---

## 3. Working with database branches

Branches are how this project tests migrations safely. A branch is a full copy-on-write clone — instant, and cheap because unchanged data is shared.

```bash
# list
neon branches list --project-id frosty-feather-79812865

# create a throwaway, auto-expiring in a week
neon branches create --name my-test --parent production \
  --project-id frosty-feather-79812865 --expires-at 2026-12-31T00:00:00Z

# connection string for it
neon connection-string my-test --project-id frosty-feather-79812865 --prisma

# delete when done
neon branches delete my-test --project-id frosty-feather-79812865
```

**A branch with an expiry date cannot have child branches.** If you need to branch *from* it later, create it without `--expires-at`.

---

## 4. Applying the migration to a fresh branch

```bash
npx prisma migrate deploy     # applies prisma/migrations/, records in _prisma_migrations
npx tsx prisma/seed.ts        # pricing rule, admin user, sample markets, feature flags
```

Verify it landed — do not trust the CLI summary alone. `migrate deploy` can report "no pending migrations" when an earlier run applied the migration and then failed on something else:

```sql
select count(*) from information_schema.tables
  where table_schema='public' and table_type='BASE TABLE';   -- expect 99 with all four migrations (98 + _prisma_migrations)
select count(*) from pg_type t join pg_namespace n on n.oid=t.typnamespace
  where n.nspname='public' and t.typtype='e';                -- expect 85
select * from _prisma_migrations;                            -- finished_at set, rolled_back_at null
```

> **Never put a folder inside `prisma/migrations/` that isn't a migration.** Prisma treats every subdirectory as one. A stray folder causes `P3015` and blocks *all* migrations. The original `manual/` folder did exactly this; it now lives at `prisma/manual/`.

---

## 5. Running the tests

```bash
npx vitest run                                          # all 33 files
npx vitest run tests/permissions/negative.test.ts       # N1–N11 security suite
```

Both need `DATABASE_URL` **and** `AUTH_SECRET` in the environment. `lib/auth.ts` refuses to start without a 32-character secret, and the failure looks unrelated to auth if you haven't seen it before.

> **Never run the suite against `production`.** The permission tests create real users. Point `DATABASE_URL` at `staging` or a throwaway branch for every test run.

Current results, 28 Oct 2026: **332 of 332 tests pass, 33 of 33 files** (310 before junk removal, plus 22 for it in `tests/junk/`). **N1–N11 is 27 of 27.** At the checkpoint on 24 Oct it was 23 of 27, with all four failures in dormant freight brokerage; those four were application-code defects and have since been fixed.

---

## 6. Backup and restore — tested, not assumed

Neon keeps continuous history, so restoring is a point-in-time operation rather than a file to find.

**This procedure was executed on 24 Oct 2026.** A table was dropped and another emptied, then recovered exactly:

```bash
# 1. note a UTC timestamp from before the damage
date -u +"%Y-%m-%dT%H:%M:%SZ"

# 2. restore, preserving the damaged state as a separate branch
neon branches restore <branch> ^self@2026-10-24T12:38:00Z \
  --preserve-under-name pre-restore-damaged \
  --project-id frosty-feather-79812865
```

`--preserve-under-name` is **required** when restoring a branch onto itself, and it is a feature, not a nuisance: the broken state is kept as its own branch so you can inspect what went wrong rather than destroying the evidence.

Result of the live test: a dropped `FeatureFlag` table and a wiped `PricingRule` both returned, with table, user, flag and pricing-row counts matching the pre-damage baseline exactly.

**Check your history retention window before relying on this.** The free plan keeps only a few hours. Anything older needs a paid tier.

Before any production migration: take a branch of production first. It is instant and it is your rollback.

---

## 7. Blockers — status

The four blockers this section listed on 24 Oct are closed:

| | Issue on 24 Oct | Now |
|---|---|---|
| **BLOCK-03** | `prisma/seed.ts` created none of the eight brokerage flags | All eight are seeded, all **off**. Read back from a copy of `production`: 8 of 8 present, 0 enabled |
| **BLOCK-05** | 34 TypeScript errors | **0** |
| **BLOCK-06** | 17 files on the Next 14 synchronous `params`; `next build` failed | All 81 dynamic route handlers and all four pages on the Next 15 form; **build green** |
| **BLOCK-08** | Cron routes exported `POST` only; Vercel Cron calls with `GET` | All three accept `GET`. Each returns 401 without `CRON_SECRET` and 200 with it |

**BLOCK-19, closed 28 Oct:** a customer whose first card attempt never reached the bank (a mistyped expiry, a decline) could never retry — the payment routes refused any second request for a booking that already had a PaymentIntent. An intent Stripe is still waiting on is now handed back; once money is held the refusal stands. Applies to moving, junk and freight bookings.

Styling was fixed pragmatically: Tailwind is installed with **preflight disabled**, so the portals render without disturbing the original design system. Two styling systems now coexist — full normalisation remains a separate piece of work.

**What is still needed before production, all of it accounts only the owner can open:** Stripe Connect (Express) and Stripe business verification · Checkr · Certificial · a Cloudflare R2 bucket · Resend, Twilio, Google Maps (two keys), Sentry and an FMCSA web key · a GitHub repository connected to Vercel. Also resolve the `directUrl` note in section 2 before production traffic.

---

## 8. When broker authority arrives

Freight brokerage is dormant pending DOT authority, MC number and the BMC-84 bond.

The code-side prerequisites this section listed on 24 Oct are complete: the eight flags exist and are recorded as off; `FreightLoad` now carries its own `proofOfDeliveryUrl`; a blocked brokerage write returns 403 instead of 500; and N1–N11 is 27 of 27. What remains is regulatory.

Turning flags on is a management action. The code never flips them on its own, by design.

---

## 9. Quick reference

```bash
npm ci && npx prisma generate           # setup
npx prisma migrate deploy               # apply migrations
npx tsx prisma/seed.ts                  # seed
npx vitest run                          # tests (needs DATABASE_URL + AUTH_SECRET; never production)
npx tsc --noEmit                        # typecheck (0 errors)
npm run build                           # production build (green)
neon branches list --project-id frosty-feather-79812865
```

Full evidence for every claim here is in the checkpoint evidence packet and work log supplied alongside this document.

---

## 10. Reproducible installs — read this before installing anything

**Always `npm ci`. Never `npm install`.**

This is not a style preference. `npm install` re-resolves the `^` ranges in
`package.json` and may write a different tree than the one that was tested; all
26 top-level dependencies use ranges. `npm ci` installs strictly from
`package-lock.json` and will not modify it. The symptom when this goes wrong is
a typecheck count that moves on its own: 34 errors were measured one day and 37
the next with no source change, which is what made the error list untrustworthy
in the first place.

```bash
npm ci          # correct. ~4.5 min cold on this project
npm install     # only when deliberately changing a dependency
```

Verified 25 Oct 2026: `npm ci` completed with exit 0 and left
`package-lock.json` byte-for-byte identical, which is the proof the lockfile is
authoritative. The lockfile holds 618 packages, every one with both a `resolved`
URL and an `integrity` hash, and all 618 resolve to `registry.npmjs.org`. None
still point at the internal proxy host that made the original lockfile unusable
(BLOCK-01).

### The measured baseline

After a clean `npm ci`, all four of these must reproduce. If any of them differs,
something in the tree moved and that is the first thing to investigate:

| Command | Expected |
|---|---|
| `npx tsc --noEmit` | 0 errors |
| `npx next build` | compiles, 126/126 static pages, 211 routes |
| `npx vitest run tests/permissions` | 27 of 27 |
| `npx vitest run` | 332 of 332, 33 of 33 files |

Measured on Node v26.8.1 / npm 11.19.0. The suite figure was 301 of 301 across 30 files on 25 Oct; nine tests were added on 28 Oct.

### Node version — resolved, and not the way it was expected to resolve

Verified on Vercel, 25 Oct 2026, by deploying to a throwaway project
(`tempmovers-build-verify`, separate from the live `tempmovers` project so the
holding page could not be affected). The build succeeded: compiled in 33.6s,
126/126 static pages, `Build Completed [2m]`.

**Vercel built on Node 24.x, not the 22.x that `engines.node` declared.** The
field was simply ignored. Both Vercel projects — the live `tempmovers` and the
verification project — are set to Node.js Version 24.x, so 24.x is the real
deployment runtime and always was.

A pin the platform ignores is worse than no pin, because it manufactures false
confidence about what the code was tested on. `engines.node` and `.nvmrc` are
therefore now `24.x` / `24`, matching the environment the build is actually
verified green in.

**The Vercel project setting wins over `engines.node`, not the other way round.**
If the Node version is ever changed, change it in Project Settings; editing
`package.json` alone will do nothing.

Current verification status:

| Runtime | Where | Result |
|---|---|---|
| Node 24.x | Vercel, the real deployment target | **build green**, 126/126 pages |
| Node 26.8.1 | local build machine | **all four gates green** |
| Node 22.x | nowhere | not tested, and no longer the target |

The build is green on two different Node majors, which is better evidence of
version robustness than a single pinned run would have been.

### The build needs no environment variables at all

Worth stating because it is unusual and it is a direct result of the BLOCK-09
fix. `next build` completes with **no `.env` present whatsoever** — verified
locally by setting the file aside, and verified again on Vercel, where the
verification project has zero environment variables configured.

This matters for deployment: no CI system and no build pipeline needs to be
handed a single secret in order to compile this application. Before BLOCK-09 it
could not be built at all without a live Stripe key.

Vercel's build also ran a clean dependency install from the lockfile in a fresh
container with `Previous build caches not available`, which is an independent
confirmation of the reproducibility claim above — a different machine, a
different Node major, a cold cache, and the same successful build.

### Install scripts

`npm ci` currently prints a warning that 8 dependencies have install scripts
"not yet covered by allowScripts", among them `@prisma/client`'s postinstall.
They do still run on npm 11.19.0 — verified by timestamp, the generated client
is newer than the rest of the install — but npm is moving toward blocking them.

This project is already safe from that change: the root `postinstall` script
runs `prisma generate`, and `npm run build` is `prisma generate && next build`.
Both are project lifecycle scripts, which the dependency-script gating does not
affect. `esbuild` and `sharp` get their native binaries from optional platform
packages rather than install scripts, so they are unaffected too.

---

## 11. Security position on the locked tree

Locking a dependency tree means accepting what is in it, so what is in it is
recorded here. As of 25 Oct 2026: **43 advisories — 2 critical, 9 high, 32
moderate.**

### Fixed

**`next` 15.5.20 -> 15.5.28.** This was not optional. 15.5.20 was exposed to
three *critical, unauthenticated* remote code execution advisories:

| Advisory | Issue | Patched in |
|---|---|---|
| `GHSA-p293-qw3h-jr36` | Unauthenticated RCE on Windows-hosted servers | 15.5.24 |
| `GHSA-2xp9-vwfh-vxw4` | Unauthenticated RCE in Image Optimization, AVIF | 15.5.24 |
| `GHSA-2464-fhr4-w9xw` | Unauthenticated RCE in Image Optimization, SVG | 15.5.28 |

Plus SSRF in rewrites via attacker-controlled destination hostname, SSRF in
Server Actions, cache poisoning of SSG/ISR pages, and unauthenticated
disclosure of internal Server Function endpoints. The two Image Optimization
entries matter most for this application because it accepts user image uploads.

15.5.28 is a patch-level move inside 15.5.x. All four gates were re-run on it
and all four are unchanged. `next` is now moderate rather than critical, and
npm raised the declared floor to `^15.5.28` so a later `npm install` cannot
drop back below the patch.

### Deliberately not fixed, with reasons

**Do not run `npm audit fix`.** It was dry-run first and it is actively unsafe
here: it attempts to resolve the `prisma` advisory by *downgrading* prisma
6.19.3 to 6.12.0 — below the version this project's migrations and generated
client were built against — and it still leaves all 43 advisories outstanding.
It fixes nothing and breaks the database tooling.

| Package | Severity | Why it is being left | What to do instead |
|---|---|---|---|
| `vitest`, `tinypool`, `vite` | 2 critical, 1 high | Dev-only; none ships in the production bundle. The vectors require the Vitest UI server or dev optimizer to be running. Fix is `vitest@5`, a major bump that risks the 310 passing tests | Upgrade on its own branch, re-run the suite, not bundled with other work |
| `zod` | high — memory exhaustion on oversized collections | Real DoS vector, since zod validates every API input on public endpoints. But zod 3 -> 4 is a breaking migration across every schema in the app | Cheap mitigation first: request body size limits at the edge. Then schedule the zod 4 migration as its own piece of work |
| `sharp` | high — inherited libvips CVEs | The project's own `sharp@0.33.5` is reached only through the portfolio image path, which is gated off (`PORTFOLIO_IMAGE_PROCESSING` is unset) and imported dynamically. Next bundles its own `sharp@0.34.5`, governed by the Next version just patched | **Bump before the portfolio image feature is enabled.** That flag must not be turned on while this is outstanding |
| `@sentry/nextjs`, `rollup` | high | Fix requires `@sentry/nextjs@11`, a major bump. Sentry is not yet configured — `SENTRY_DSN` is empty — so nothing is live | Upgrade when Sentry is actually wired up, not before |
| `prisma`, `@prisma/config` | high | The only offered "fix" is a downgrade to 6.12.0, which is worse than the advisory | Wait for a forward fix in the 6.19+ line |

### The one rule

Re-run `npm audit` after any dependency change, and do not enable the portfolio
image processing flag until `sharp` is bumped.

---

## 12. Junk removal

Added 28 October 2026 from the junk-removal build spec (11-page revision), on its own branch, `feature/junk-removal`, then re-validated: typecheck, production build, the full suite, and a complete junk booking on the staging deployment.

**How it runs**

- The customer books at `/book/junk` — linked from the homepage Junk Removal card and footer — in three steps: what's going, crew and price, review and pay. Pricing is by truckload tier or by item, with a minimum. The quote is one all-in price with disposal included; the $9.95 booking protection is the only amount added on top.
- Since 29 October the full amount is collected at booking (§13). Like every booking, the job reaches workers only once the money is confirmed collected.
- The crew is a hauler, who brings the truck, plus up to two helpers, sized from the load and how hard it is to reach. Since 29 October pay follows the full allocation in §13: the disposal set-aside comes out of the price first, the platform fee is 30% of what is left, helpers are paid by the hour, and the hauler gets the rest plus the disposal reimbursement against the dump receipt.
- Junk jobs reach junk-only accounts (sign-up options "Box truck — junk removal only" and "Junk removal only"), and movers and box-truck drivers who switch on **Take junk removal jobs** in their dashboard. Their dashboard has a junk board: open jobs with what their seat pays, then their own jobs with the address, check in and out, before and after photos, and the dump receipt.
- The customer approves the crew as with any job; the job is then settled (§13), which fixes each person's pay and refunds anything unused.

**Switching it on for a market**

Admin → Markets → **Junk removal** (`LaunchMarket.junkRemovalEnabled`). Indianapolis is on in the seed. A market must also be taking customer bookings. This is the switch that actually gates booking; `FeatureFlag.enabledServiceTypes` is advisory and gates nothing.

**Setting prices**

Through the admin pricing engine, per market, falling back to `US-DEFAULT` and then to the defaults in `lib/junk/pricing.ts` (the spec's proposed Indianapolis prices):

```bash
PUT /api/admin/pricing
{ "marketCode": "INDY", "junkTakeRatePercent": 30, "junkHelperSharePercent": 25,
  "junkPriceTable": { "tiersCents": { "QUARTER": 15900 }, "surchargesCents": { "FREON_APPLIANCE": 2500 } } }
```

Anything left out keeps its default; `"junkPriceTable": null` resets a market to the defaults. All amounts are integer cents. Special-item surcharges default to $0 until they are set.

Since 29 October `junkHelperSharePercent` no longer affects pay (helpers are hourly) and the junk platform fee comes from the payment policy's `junkPlatformFeeBps` (§13), not `junkTakeRatePercent`. The tier, item and surcharge prices here still set the all-in price.

**Photos and receipts**

They use the same private storage as worker documents. Until the storage bucket is configured, the upload buttons say so plainly and everything else works.

**Open decisions for the owner**

Confirm the Indianapolis prices; set the special-item surcharges; confirm the crew-size rule (one hauler alone for a small curbside pickup, a helper for anything inside, heavy or larger, two helpers for a large load that is also heavy or upstairs or in a basement). The pay values are in §13.

## 13. Pay before dispatch

Added 29 October 2026 from the pay-before-dispatch work order and the payment structure spec v1.0, on its own branch, `feature/pay-before-dispatch`, cut from the junk branch. Additive migration `20261029150000_add_pay_before_dispatch`: new enums and tables only, nothing existing changed. Re-validated the same way as junk: typecheck, the full suite, and a 52-check end-to-end run on the staging deployment with Stripe test cards.

**How it runs**

- The customer pays the full amount when they book, by card. The job sits in `DRAFT` until the server sees the money collected; only then does it reach workers. An authorisation, a pending bank payment or a browser success page never counts.
- The same check runs on the server at every path that dispatches or starts work: a worker taking a job, accepting an invitation, checking in; a driver claiming or picking up a load; a dispatcher or admin moving a brokered load; a carrier accepting an offer. A stale screen cannot start an unpaid job. The open load board lists only paid loads.
- Added work is a change order: the crew (or an admin) proposes it, the server prices it, the customer approves and pays it in their dashboard, and only a paid change order lets the extra work count. Extra hours, another helper, extra items and a dump bill over the allowance are the kinds.
- When every worker's hours are approved, the admin **settles** the job — the same button that used to capture. Settlement works out the final amount (approved hours, or the junk allocation), refunds anything prepaid and unused in full, writes one allocation row for every cent collected, and releases worker payouts. Payouts are `PENDING` from approval until settlement, then `SCHEDULED`; a payout cannot be paid before the job is settled.
- A customer can cancel before the crew checks in and is refunded in full, booking protection included. There is no cancellation fee until one is set.
- For loads, accepting the proof of delivery (the same admin button) records the load's settlement; a prepaid load joins the carrier's settlement batch only after that.
- Legacy bookings made under the old terms still work: an authorised one is collected in full with `POST /api/admin/jobs/{id}/collect-legacy` (nothing is charged twice) and then follows the new path.

**Junk pay (the full allocation)**

Disposal set-aside out of the all-in price first, with no platform cut on it; platform fee 30% of the service subtotal, rounded once; helpers $30 an hour from check-in to release, 2-hour minimum, 15-minute steps; the hauler gets the rest plus the disposal reimbursement against the receipt. A second helper raises the price so the hauler is never docked for it; a quote that would leave the hauler under the earnings floor after the truck allowance is repriced up. The hauler enters the dump cost from their job card; with a receipt on file and an amount within the allowance it is approved on the spot and any unused allowance is refunded to the customer. Anything else is held for admin review:

```bash
POST /api/admin/disposal/{jobId}/review
{ "decision": "APPROVE", "approvedCents": 9000, "note": "Receipt checked by phone", "waiveReceipt": true }
```

Approving without a receipt needs `waiveReceipt` and a note, and is written as an audited exception. A missing receipt holds only the reimbursement, never the rest of anyone's pay. The approved reimbursement is paid on its own with `POST /api/admin/allocations/{allocationId}/transfer`.

**The values, per market**

Every number below is a proposal until the owner approves it. They apply to new quotes; booked jobs keep the snapshot they were quoted with.

```bash
GET  /api/admin/payment-policy?marketCode=INDY
PATCH /api/admin/payment-policy
{ "marketCode": "INDY", "junkPlatformFeeBps": 3000, "helperHourlyCents": 3000, "helperMinimumMinutes": 120,
  "helperIncrementMinutes": 15, "haulerFloorCents": 4000, "truckAllowanceCents": 1000,
  "disposalEstimatesCents": { "HALF": 8000 }, "disposalAddersCents": { "FREON_APPLIANCE": 2000 },
  "disposalAutoApproveCents": 20000, "reviewWindowHours": 24, "achEnabled": false, "markCarlApproved": true }
```

Anything left out keeps its current value; a market falls back to `US-DEFAULT`, then to the built-in proposals. `markCarlApproved` records the owner's sign-off date. Keep `achEnabled` off until bank payments have been tested; cards are collected immediately, and bank debits only count once the funds are available.

**Seeing the money**

`GET /api/admin/funding?type=JOB&id={jobId}` shows the gate's verdict re-read from Stripe and everything behind it: quote versions, each payment and its state, change orders, the settlement and its allocations, the disposal record, refunds, exceptions, and whether the allocations add up to what was collected. Customers see their own payment, change orders, receipts and refunds under **Payment & changes** on each job; workers see only their own pay basis and status.

**Exceptions, written down**

`POST /api/admin/payment-exceptions` with `{ "action": "create", "entityType": "JOB", "entityId": "...", "kind": "CREDIT_TERMS", "reason": "..." }` lets an unpaid job or load dispatch under agreed credit terms; `"kind": "EVIDENCE_WAIVER"` lets a job settle without the required photos. Each one names who, when and why, and `"action": "revoke"` ends it. Nothing bypasses the gate silently.

**Daily check**

`/api/cron/funding-reconcile` runs at 10:00 UTC (in `vercel.json`): it re-reads recent payments from Stripe, then alerts on crewed or started jobs that are not funded, payments stuck processing, settlements that do not balance, and checked-out work waiting past the review window. It flags; it never moves money.

**Not built, by design or yet**

Deferred collection for long-lead bookings (the spec proposed charging 24 hours before service) — cards are charged at booking. Bank (ACH) payments are off. Worker transfers need Stripe Connect enabled; photos and receipts need the storage bucket.

## 14. Launch waitlist

Added 29 October 2026 from the waitlist work order, on `feature/waitlist` off `main`. Additive migration `20261029120000_add_waitlist_signup`: one enum and one table, nothing existing changed. That migration is already applied to production; the junk and pay-before-dispatch migrations are not yet.

**Where signups come from**

- The coming-soon site on `tempmovers.com` (the static site, source folder `tempmovers-site`): the form on the home page and on `/junk-removal/`, posting to the site's own `/api/waitlist` function, which writes to the production `WaitlistSignup` table. The function reads `DATABASE_URL` from the Vercel **Production** environment.
- The platform itself: `POST /api/waitlist`, the same contract, so nothing changes when the platform replaces the coming-soon page.

Email is the only required field. Each visitor's address gets about five tries a minute, a hidden field catches bots, a repeat signup updates rather than duplicates, and one email may be on both the customer and worker lists. `utm_source`, `utm_medium` and `utm_campaign` on the link are kept in `source`.

**Seeing the list**

Admin → `/admin/waitlist`: totals (all, customers, workers), filters by list and ZIP, and **Export CSV** (`GET /api/admin/waitlist?format=csv`). The screen reads whichever database the platform is pointed at, so until the platform runs on production it will not show the live signups; export them from production with the same route once it does.

**Privacy**

The form links to `/privacy/`, a placeholder until the full policy is published. There is no email service on the domain yet, so the placeholder lists no contact address.
