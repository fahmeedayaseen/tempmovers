# TempMovers — Staging Handoff (Frozen Consolidation-Checkpoint Artifact)

This zip is the **frozen artifact** for the consolidation checkpoint. Take it through the
approved runbook without changing code/schema/config between steps 1 and 14.

## Start here
1. Read **`STAGING_CHECKPOINT_RUNBOOK.md`** (the 16-step sequence + freeze rules + evidence packet).
2. Companion documents are in **`checkpoint-docs/`**:
   - `TempMovers_Consolidated_Migration_Plan.docx`
   - `TempMovers_Role_Permission_Matrix.docx`
   - `TempMovers_Launch_Blocker_Register.docx` (single source of truth for GO/NO-GO)

## Frozen-artifact fingerprint (confirm before you begin)
- `prisma/schema.prisma` sha256: `aebd20c95f2ad75c4794a37c4c31652979a37d0c5fe4dfb6c6c4d7770ef85be6`
- schema.prisma: **97 models, 85 enums**
- TypeScript source files (.ts/.tsx): **390**, all pass a syntax check

If any of these differ from what you unzip, the artifact is not what was validated — stop
and reconcile before migrating.

## Key paths
- Runbook: `STAGING_CHECKPOINT_RUNBOOK.md`
- MarketStage reconcile SQL (Step 5): `prisma/migrations/manual/market_stage_reconcile.sql`
- N1–N11 permission suite (Step 14): `tests/permissions/harness.ts`, `tests/permissions/negative.test.ts`
- Schema: `prisma/schema.prisma`

## Environment expectations (why this must run on your side, not in a build sandbox)
The full checkpoint needs a live environment the build sandbox does not have:
- a real PostgreSQL for the clean-DB and staging-copy migrations,
- network access for `prisma generate`'s engine download,
- Stripe test-mode keys (INT-01), S3/object storage (INT-02), FMCSA access (INT-03),
- a scheduler for cron jobs (INT-04), and an email/SMS provider (INT-06).

Node 18+ and the repo's pinned Prisma version are assumed. Install with your normal
`npm install` (node_modules is intentionally excluded from this zip).

## The one rule that makes this defensible
No blocker-register row is marked PASS without captured execution evidence
(command, timestamp/commit SHA, environment, exit code, output). Nothing passes on code
review alone. Permission gates are proven only by N1–N11 running green against the migrated
test DB.
