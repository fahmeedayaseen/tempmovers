# TempMovers — Staging Checkpoint Runbook (Consolidation Checkpoint)

**Purpose:** Take one frozen migration artifact all the way through clean-DB, staging-copy,
build, and permission-evidence, then into live-integration and end-to-end validation.
This is the transition from "feature-complete in source code" to "candidate for a
controlled Indianapolis launch."

**Authoritative companion documents (hand off alongside this repo):**
- `TempMovers_Consolidated_Migration_Plan.docx`
- `TempMovers_Role_Permission_Matrix.docx`
- `TempMovers_Launch_Blocker_Register.docx` ← the single source of truth for GO/NO-GO

---

## FREEZE — read this first

**The schema/code target is FROZEN for the duration of steps 1–14.**

Do **not** add, change, or "clean up" any code, schema, `package.json`, seed, test, or
config between steps 1 and 14 — including changes that look non-functional. Even an
import reorder, a dependency bump, or a seed tweak creates a **new artifact boundary**
and invalidates the evidence gathered so far. This is exactly the drift that blocker
**MIG-00** already exposed once.

**If you hit a blocker that genuinely prevents execution:**
1. **Stop.**
2. **Document** it (command, output, exit code, environment, commit SHA).
3. **Fix only that blocker** — nothing else.
4. **Re-freeze** at a new commit SHA.
5. **Restart the affected validation sequence** from the appropriate step.

**No blocker row is marked PASS without captured execution evidence.** Nothing passes on
code review alone. Permission gates (PERM-01–07) are proven only by the N1–N11 suite
running green against the migrated test DB.

---

## Evidence packet (capture for EVERY step)

For each step below, record:
- **Command** run (verbatim)
- **Timestamp** and **commit SHA** of the frozen artifact
- **Environment** (clean-DB / staging-copy / CI, DB name, node & prisma versions)
- **Exit code**
- **Relevant output** (SQL diff, counts, test results — attach the actual output, not a summary)

Store these together as the checkpoint evidence packet. The blocker register's
Evidence/Result column should reference the corresponding packet entry.

---

## Frozen-artifact facts (as shipped in this zip)

Use these as the expected baseline. If any differ in the exact `schema.prisma` you are
migrating, **stop — the artifact is not what was validated.**

- `prisma/schema.prisma`: **97 models, 85 enums**
- MIG-00 values that must be present (see Step 1):
  - `RECRUITER` in `enum UserRole`
  - `DISPATCHER` in `enum UserRole`
  - `model ShipperQuoteRequest`
  - `enum ShipperQuoteRequestStatus`
- MarketStage reconcile SQL: `prisma/migrations/manual/market_stage_reconcile.sql`
- N1–N11 permission suite: `tests/permissions/harness.ts`, `tests/permissions/negative.test.ts`

---

## The sequence — execute in order, do not jump ahead

### Step 1 — Re-verify MIG-00 against the EXACT schema being migrated
Immediately before `prisma migrate dev --create-only`. Capture the command output as the
MIG-00 evidence string (stronger than a manual acknowledgment):

```bash
grep -n 'RECRUITER\|DISPATCHER' prisma/schema.prisma
grep -n '^model ShipperQuoteRequest ' prisma/schema.prisma
grep -n '^enum ShipperQuoteRequestStatus ' prisma/schema.prisma
```

**Expected:** `RECRUITER` and `DISPATCHER` both present in `UserRole`; `ShipperQuoteRequest`
model and `ShipperQuoteRequestStatus` enum both present. If any is missing, STOP — this is
the MIG-00 drift; do not proceed to create-only.
→ Register: re-affirm **MIG-00 = RESOLVED** with this captured output.

### Step 2 — Prisma generate
```bash
npx prisma generate
```
Must succeed against the frozen schema. Capture exit code + version.

### Step 3 — Generate the migration (create-only, applies nothing yet)
```bash
npx prisma migrate dev --create-only --name consolidated_checkpoint
```
This writes the migration SQL WITHOUT applying it. → Register: **MIG-01** in progress.

### Step 4 — Inspect the generated SQL before applying anything
Open the generated `migration.sql`. Confirm:
- All new models/enums/columns from the delta inventory are present (see Migration Plan §2).
- **NO `DROP TYPE` on `MarketStage`.**
- **NO `DROP COLUMN` / `DROP TABLE`** on `LaunchMarket`, `FreightLoad`, or any table
  holding production data.
- New columns are nullable or have safe defaults.

If Prisma generated a destructive `MarketStage` drop/recreate, that block must be
**replaced** by the manual reconciliation in Step 5. → Register: **MIG-01** evidence =
the inspected SQL.

### Step 5 — Merge the MarketStage reconciliation; verify no destructive drops
Replace any Prisma-generated `MarketStage` enum change with the hand-written, data-preserving
reconciliation:
```
prisma/migrations/manual/market_stage_reconcile.sql
```
It maps old→new stage values explicitly inside a transaction
(`PIPELINE→PLANNING`, `SUPPLY_BUILD→CARRIER_RECRUITMENT`,
`CONTROLLED_LAUNCH→SOFT_LAUNCH`, `EXPANSION_READY→ACTIVE`, `PAUSED` unchanged) and never
drops the column or the type in a way that loses rows. Re-scan the merged SQL for any
remaining `DROP TYPE`/`DROP COLUMN` affecting existing data. → Register: **MIG-02**.

### Step 6 — Apply to a completely clean database
```bash
npx prisma migrate deploy   # against a fresh, empty DB
```
→ Register: **MIG-03** (apply portion).

### Step 7 — Seed; verify all eight brokerage flags remain OFF
Run your seed, then confirm the brokerage master + seven capability flags are all OFF:
- `FREIGHT_BROKERAGE_ENABLED` (master)
- `LOAD_POSTING_ENABLED`, `CARRIER_LOAD_ACCEPTANCE_ENABLED`, `DISPATCH_SERVICES_ENABLED`,
  `DIRECT_SHIPPER_QUOTING_ENABLED`, `CARRIER_PAYMENTS_ENABLED`,
  `BROKER_CARRIER_AGREEMENTS_ENABLED`, `RATE_CONFIRMATION_GENERATION_ENABLED`

**Do not enable production brokerage.** N10 and the E2E run rely on flags being OFF; use
test fixtures only. → Register: **MIG-07** + MIG-03 (seed portion).

### Step 8 — Prisma generate + existing unit/integration suite
```bash
npx prisma generate
# then your existing test command, e.g.:
npx vitest run
```
→ Register: **MIG-03** (tests portion) + **MIG-06** (existing suite).

### Step 9 — Apply the SAME migration to a restored staging-copy DB
Restore a copy of staging, then apply the identical migration artifact (no regen).
→ Register: **MIG-04** (apply portion).

### Step 10 — Compare pre/post row counts and FK integrity
On the staging copy, confirm only intended additive changes:
- No unexpected row-count drops on existing tables.
- Foreign keys intact (spot-check `FreightLoad` → stops/offers/settlements).
- `MarketStage` rows preserved and correctly remapped.
→ Register: **MIG-04** (comparison evidence).

### Step 11 — Typecheck
```bash
npx tsc --noEmit
```
→ Register: **MIG-05** (typecheck portion).

### Step 12 — Production Next.js build
```bash
npm run build
```
→ Register: **MIG-05** (build portion).

### Step 13 — Existing API integration suite
Run against the migrated clean DB. → Register: **MIG-06**.

### Step 14 — Run the NEW N1–N11 permission suite against the migrated DB
```bash
npx vitest run tests/permissions/negative.test.ts
```
These call the **actual exported route handlers** with real DB-backed sessions. Attach the
**actual test results** to the evidence packet — not the word "PASS."

The eleven cases (see Role/Permission Matrix §7):
- **N1** recruiter → factoring & settlements = 401/403
- **N2** dispatcher → admin = 401/403
- **N3** dispatcher (no grant) → carrier loads = 403
- **N4** dispatcher `VIEW_LOADS` only → status update = 403
- **N5** Carrier B never sees Carrier A data
- **N6** shipper load-detail JSON contains **no** `carrier*`/margin/platform/fees keys
- **N7** carrier identity hidden while `OFFERED`; visible once `DISPATCHED`
- **N8** support → settlements = 401/403
- **N9** every non-finance role → settlement POST = 401/403
- **N10** brokered write blocked while flags OFF (403 capability)
- **N11** customer/worker/driver → carrier/recruiting/freight = 401/403

**Prerequisite:** a migrated, seeded test DB (that's why this is Step 14, after the
migration is proven). The suite uses `createSession` to mint real tokens and asserts real
status codes + serialized JSON, so it fails if a guard is later weakened.
→ Register: **PERM-01–07**.

### Step 15 — Update MIG/PERM rows with actual command/result evidence
Only now. Each row's Status moves off NOT TESTED **only** with captured evidence
(command, SHA, environment, exit code, output). No code-review PASS.

### Step 16 — INT-01–06 and E2E-01–03 staging validation
With the migration proven, move into the live-integration and end-to-end rows:
- **INT-01** Stripe test-mode $0 reconciliation
- **INT-02** S3/object-storage presigned upload/download round-trip (private, expiring)
- **INT-03** FMCSA live lookup + simulated outage → `PROVIDER_UNAVAILABLE` (not rejection)
- **INT-04** cron/scheduled jobs fire (fmcsa-reverify, authorization-expiry, reconcile-checkr)
- **INT-05** payout/settlement execution stays DISABLED while dormant (prep ≠ payment)
- **INT-06** email/SMS delivery
- **E2E-01** Shipper → Freight Ops → offer → execution → POD → admin approval → invoice →
  settlement-prep (brokerage flags OFF via fixtures; money integer-cents throughout;
  every transition audited)
- **E2E-02** factoring / payment-routing enforcement in-chain (active NOA locks remittance
  → admin review 428; shipper never sees it)
- **E2E-03** recruiter → convert → carrier onboarding continuity (no onboarding skip)

---

## GO / NO-GO

TempMovers remains **NO-GO** for production until **every `Production Blocking = YES` row**
in the launch-blocker register is **PASS**, with captured evidence, on **both** a clean
database **and** a staging copy, with **brokerage flags confirmed OFF.** The register is the
single source of truth for that decision.

## What NOT to do during this checkpoint
- Do not enable any brokerage capability flag in a shared/staging environment to "test" freight.
- Do not add features (freight, recruiting, dispatcher, factoring, carrier) between steps 1–14.
- Do not mark a row PASS from code inspection.
- Do not regenerate the migration between the clean-DB run (Step 6) and the staging-copy run
  (Step 9) — it must be the *same* artifact.
