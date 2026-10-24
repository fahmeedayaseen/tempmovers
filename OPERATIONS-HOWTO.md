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
