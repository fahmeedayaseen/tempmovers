# TempMovers — Operations How-To

Written by VASRUE Digital Media, 24 October 2026, as part of the consolidation checkpoint.
Every command below has been run against this project. Nothing here is theoretical.

---

## 1. Where things stand

The database now exists. It never did before this checkpoint — the artifact shipped with no migration history at all.

| | |
|---|---|
| Database | Neon, project `frosty-feather-79812865` |
| Branches | `production` (default, empty) · `migration-test` (migrated + seeded) |
| Migration | `prisma/migrations/20261024121500_init` — 97 tables, 85 enums, 135 foreign keys |
| App host | Vercel team `tempmovers-team` (Pro). **No project created yet** |
| Documents | Cloudflare R2 — **not provisioned yet** |

**Production is NO-GO**, and not because of the database. See section 7.

---

## 2. One-time setup on a new machine

```bash
npm install                 # needs the lockfile fix already in this repo
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
  where table_schema='public' and table_type='BASE TABLE';   -- expect 98 (97 + _prisma_migrations)
select count(*) from pg_type t join pg_namespace n on n.oid=t.typnamespace
  where n.nspname='public' and t.typtype='e';                -- expect 85
select * from _prisma_migrations;                            -- finished_at set, rolled_back_at null
```

> **Never put a folder inside `prisma/migrations/` that isn't a migration.** Prisma treats every subdirectory as one. A stray folder causes `P3015` and blocks *all* migrations. The original `manual/` folder did exactly this; it now lives at `prisma/manual/`.

---

## 5. Running the tests

```bash
npx vitest run                                          # all 30 files
npx vitest run tests/permissions/negative.test.ts       # N1–N11 security suite
```

Both need `DATABASE_URL` **and** `AUTH_SECRET` in the environment. `lib/auth.ts` refuses to start without a 32-character secret, and the failure looks unrelated to auth if you haven't seen it before.

Current results: **267 business-logic tests pass. N1–N11 is 23 of 27** — every test in the launch-safe domains passes; all four failures are in dormant freight brokerage. See section 7.

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

## 7. Known blockers

Production GO is blocked by application-code defects, not by database work.

| | Issue | Impact |
|---|---|---|
| **BLOCK-03** | `prisma/seed.ts` creates none of the eight brokerage flags the checkpoint requires evidence for. It creates five unrelated ones | Behaviour is safe — the gate fails closed, so a missing flag reads as OFF. The *evidence* cannot be produced. `DISPATCH_SERVICES_ENABLED` is caught in the same gap, so dispatch support comes up off |
| **BLOCK-05** | 34 TypeScript errors. 17 are code querying fields that don't exist, or exist on the other load model | `tsc --noEmit` fails. At least one route — `app/api/shipper/loads/[loadId]` — throws on every request |
| **BLOCK-06** | 17 files still use the Next 14 synchronous `params`. Next 15 requires a `Promise` | **`next build` fails.** 68 of 81 route handlers were already migrated; the 13 that weren't, plus all 4 pages, are the newer portals |
| **BLOCK-08** | All three cron routes export `POST` only. Vercel Cron invokes with `GET` | Scheduled jobs return 405 and silently do nothing. `vercel.json` is in place but inert until the routes accept GET |

Styling was fixed pragmatically: Tailwind is installed with **preflight disabled**, so the portals render without disturbing the original design system. Two styling systems now coexist — full normalisation remains a separate piece of work.

---

## 8. When broker authority arrives

Freight brokerage is dormant pending DOT authority, MC number and the BMC-84 bond. Before switching any flag on:

1. Fix BLOCK-03 so the eight flags exist and their state is recorded.
2. Settle the load-model question: `proofOfDeliveryUrl` exists on `CarrierRoute`, not `FreightLoad`, and the shipper endpoint queries the wrong one. Decide whether the endpoint should read `CarrierRoute`, whether `FreightLoad` needs its own field, or whether shippers shouldn't see it.
3. Fix the uncaught `BrokerageNotAuthorizedError` in `app/api/freight/loads/route.ts` PATCH so a blocked write returns 403 rather than escaping as a 500. The gate itself works correctly.
4. Re-run N1–N11 and expect 27 of 27.

Turning flags on is a management action. The code never flips them on its own, by design.

---

## 9. Quick reference

```bash
npm install && npx prisma generate      # setup
npx prisma migrate deploy               # apply migrations
npx tsx prisma/seed.ts                  # seed
npx vitest run                          # tests (needs DATABASE_URL + AUTH_SECRET)
npx tsc --noEmit                        # typecheck (currently 34 errors)
npm run build                           # production build (currently fails, BLOCK-06)
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
| `npx vitest run` | 301 of 301, 30 of 30 files |

Measured on Node v26.8.1 / npm 11.19.0.

### Node version — an open discrepancy, stated plainly

`package.json` pins `engines.node` to `22.x` and `.nvmrc` says `22`, because
that is the deployment target. **The baseline above was measured on Node
v26.8.1**, because no Node version manager is installed on the build machine and
22.x is not available there.

The gates have therefore not been verified on the version that will actually
run in production. Close this before production GO, by either of:

1. Installing a version manager (`nvm-windows`, `fnm`) and re-running the four
   gates on Node 22.x; or
2. Letting a Vercel preview deployment build it, which uses `engines.node` and
   so builds on 22.x in the real target environment.

Option 2 is cheaper and tests the real thing. Neither is optional.

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
| `vitest`, `tinypool`, `vite` | 2 critical, 1 high | Dev-only; none ships in the production bundle. The vectors require the Vitest UI server or dev optimizer to be running. Fix is `vitest@5`, a major bump that risks the 301 passing tests | Upgrade on its own branch, re-run the suite, not bundled with other work |
| `zod` | high — memory exhaustion on oversized collections | Real DoS vector, since zod validates every API input on public endpoints. But zod 3 -> 4 is a breaking migration across every schema in the app | Cheap mitigation first: request body size limits at the edge. Then schedule the zod 4 migration as its own piece of work |
| `sharp` | high — inherited libvips CVEs | The project's own `sharp@0.33.5` is reached only through the portfolio image path, which is gated off (`PORTFOLIO_IMAGE_PROCESSING` is unset) and imported dynamically. Next bundles its own `sharp@0.34.5`, governed by the Next version just patched | **Bump before the portfolio image feature is enabled.** That flag must not be turned on while this is outstanding |
| `@sentry/nextjs`, `rollup` | high | Fix requires `@sentry/nextjs@11`, a major bump. Sentry is not yet configured — `SENTRY_DSN` is empty — so nothing is live | Upgrade when Sentry is actually wired up, not before |
| `prisma`, `@prisma/config` | high | The only offered "fix" is a downgrade to 6.12.0, which is worse than the advisory | Wait for a forward fix in the 6.19+ line |

### The one rule

Re-run `npm audit` after any dependency change, and do not enable the portfolio
image processing flag until `sharp` is bumped.
