# TempMovers Marketplace — Phase 1: Marketplace Profile System

**Version:** v1-phase1-marketplace-profiles
**Roadmap position:** 1 of 6 (Marketplace Profile System → Preferred
Network Management → Choose Your Helper → Freight Invitations →
Messaging → Analytics)

---

## What this phase delivers

A reusable worker/driver profile system — safe public data, vehicle and
equipment detail, verification status, and review highlights — exposed
through one canonical backend selection and one reusable frontend card,
so every later phase (Preferred Network, Choose Your Helper, Freight
Invitations) renders workers identically instead of each building its
own summary view.

This phase also includes backend work from the prior development
round that the profile system depends on or that was completed
alongside it: `PreferredWorker` CRUD, the worker directory search this
phase's UI is built on, moving-job and freight invitations, the shared
freight claim helper, and customer posting modes. Those are documented
in full in `README.md` under their own sections: search for "Steps
1–7" and "Preferred Network & Choose Your Helper."

## New in this specific phase

### Backend
- **`GET /api/workers/[workerId]/profile`** — a single worker's public
  profile: `SAFE_WORKER_SELECT` fields plus up to 10 recent
  `PUBLISHED` review highlights (rating, comment, tags — never the
  reviewing customer's identity). Open to any authenticated
  `CUSTOMER`/`ADMIN`, unlike the worker directory, which is scoped to
  a specific partner's search.

### Frontend
- **`components/WorkerProfileCard.tsx`** — the reusable card. Props
  match `SAFE_WORKER_SELECT` exactly and deliberately — expanding what
  the card shows means expanding the shared select first, not adding a
  second fetch.
- **Worker Directory panel** in the admin/business dashboard view,
  using the existing `GET /api/partners/[partnerId]/worker-directory`
  endpoint, rendering results as a grid of `WorkerProfileCard`s.

## Schema diff this phase depends on (already applied to `schema.prisma`)

```prisma
// Already present from the prior round — listed here because this
// phase's UI depends on them:
enum JobPostingMode {
  OPEN_MARKETPLACE
  PREFERRED_NETWORK_FIRST
  INVITE_SPECIFIC_WORKERS
  PRIVATE_INVITATION_ONLY
}

model PreferredWorker {
  // ...
  createdAt DateTime @default(now())
}

model Assignment {
  // ...
  createdAt   DateTime  @default(now())
  expiresAt   DateTime?
  respondedAt DateTime?
}
```

No NEW schema changes were required for Phase 1 itself — the profile
system is read-only over existing `WorkerProfile`, `Vehicle`,
`WorkerMarket`, and `Review` data.

## API reference (this phase)

### `GET /api/workers/{workerId}/profile`
**Auth:** `CUSTOMER` or `ADMIN`
**Response:**
```json
{
  "worker": {
    "id": "...", "displayName": "...", "workerType": "MOVER",
    "ratingAverage": 4.8, "ratingCount": 12, "completedJobs": 34,
    "serviceRadiusMiles": 30, "identityVerification": "APPROVED",
    "workerMarkets": [{ "market": { "name": "Indianapolis", "state": "IN" } }],
    "vehicles": [{ "type": "BOX_TRUCK", "hasLiftgate": true, "hasPalletJack": false, "capacityDescription": "16ft" }]
  },
  "reviews": [{ "rating": 5, "comment": "...", "tags": [...], "createdAt": "..." }]
}
```
**Errors:** `404` worker not found.

### `GET /api/partners/{partnerId}/worker-directory` (from the prior round, consumed by this phase's UI)
**Auth:** `CUSTOMER` (must own the partner) or `ADMIN`
**Query:** `query` (name, optional), `workerType` (optional),
`marketId` (optional)
**Response:** `{ "workers": [ ...SAFE_WORKER_SELECT shape... ] }`
**Filters to:** `operationalStatus: "ACTIVE"` only.

## Regression notes — static verification, not test execution

This sandbox has no `npm install` access, so nothing below was
*executed*. What follows is exactly what it says: syntax parsing and
static schema validation, not a test run.

| Check | Result |
|---|---|
| TypeScript syntax check (per-file, `transpileModule`) | 174 files, 0 errors |
| Duplicate-declaration scanner (block-scope-aware, real AST) | 181 files, 0 genuine duplicates |
| `schema.prisma` brace balance | Balanced |
| `schema.prisma` duplicate-field check (per model) | None found |
| `package.json` JSON validity | Valid |

**What this does NOT confirm**: that the app actually compiles under a
real `tsc --noEmit` (cross-file type errors have been found this way
before in this project — see the README's `area: "payment"` type
mismatch entry), that it builds, that any route actually executes
against a real database, or that `SAFE_WORKER_SELECT`'s shape actually
matches what `WorkerProfileCard.tsx` expects at the type level rather
than just structurally on paper.

## Deployment instructions for this phase

In a real environment with a working Prisma CLI:

```bash
npm ci
npx prisma generate
npx prisma migrate dev --name marketplace_profile_system_phase1
npx tsc --noEmit
npm run lint
npm test
npm run build
```

No new environment variables are required for this phase specifically
— it uses the existing database connection and auth stack.

**Before this phase is genuinely production-ready:**
1. Run the commands above and fix whatever the real compiler surfaces.
2. Manually verify `WorkerProfileCard.tsx` renders correctly against
   real API responses in a browser — this has been reasoned through
   and syntax-checked, never rendered.
3. Confirm the review-highlight query's performance at realistic data
   volume — `take: 10` with no cursor pagination is fine for a launch
   market, not necessarily for a worker with hundreds of reviews later.

## What's explicitly NOT in this phase

Adding/removing preferred workers (Phase 2), inviting a specific
worker to a job or load from the profile card itself (Phase 3),
freight-specific invitation UI (Phase 4), any messaging surface
(Phase 5), and any analytics/reporting on marketplace activity
(Phase 6). The backend for job/load invitations and preferred-worker
CRUD already exists (prior round) but has no frontend yet — that
frontend is Phase 2/3's deliverable, not this one's.
