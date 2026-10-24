# TempMovers Marketplace — Phase 3: Choose Your Helper

**Version:** v1-phase3-choose-your-helper
**Roadmap position:** 3 of 6 (Marketplace Profile System → Preferred
Network Management → **Choose Your Helper** → Freight Invitations →
Messaging → Analytics)
**Builds on:** Phase 1 (`WorkerProfileCard`, `SAFE_WORKER_SELECT`,
worker directory, single-worker profile), Phase 2 (`PreferredWorker`
CRUD, `lib/partner-permissions.ts`)

---

## What this phase delivers

The complete, continuous workflow the direction asked for:

**Browse → View Profile → Preferred Network → Invite → Accept/Decline
→ Assignment**

No new worker-selection UI was built — every step reuses
`WorkerProfileCard` from Phase 1 and the directory/roster panels from
Phases 1–2. The only genuinely new UI this phase adds is the invite
target picker, the worker-side invitation inbox, and customer-side
invitation tracking.

## New in this specific phase

### Backend

- **`GET /api/jobs/[jobId]/invitations`** and **`GET
  /api/loads/[loadId]/invitations`** (added to the load route file,
  purely additively, alongside its existing `POST`) — customer-side
  invitation status tracking. Deliberately separate from `GET
  /api/jobs/[jobId]/assignments` (built for the Approve Hours flow in
  an earlier round), which only ever shows `CHECKED_OUT`/`APPROVED` —
  widening that route's filter would have risked that flow; a
  dedicated endpoint was the safer fix.
- **Customer notification on invitation response** — a real gap found
  during this phase's review: none of the four accept/decline routes
  notified the customer who sent the invitation. Added
  `invitationResponseTemplate` and wired it into all four
  (`assignments/[id]/accept`, `.../decline`,
  `load-invitations/[id]/accept`, `.../decline`).
  **A mistake caught and fixed while building this**: the first draft
  referenced `CustomerProfile.displayName`, which doesn't exist on
  that model — caught by checking the schema directly rather than
  assuming, and corrected to the established `user.firstName` pattern
  already used elsewhere in this codebase.

### Frontend

- **Invite action** on `WorkerProfileCard`, wired into both the Worker
  Directory and Preferred Network roster — the same card, the same
  component, no duplicate.
- **Target picker**: opens a real panel showing the customer's own
  open jobs (`GET /api/jobs`, filtered to `POSTED`/`MATCHING`/
  `PARTIALLY_FILLED`) for a mover, or open loads (`GET
  /api/loads/mine`, filtered to `OPEN`/`OFFER_RECEIVED`) for a driver.
  Shows title, status, schedule, and (for jobs) crew size — final
  eligibility (market, capacity, assignment status) is authoritative
  on the backend; this picker shows a reasonable candidate list, not a
  second copy of that validation.
- **Worker/driver invitation inbox**: real "Job invitations" (mover
  view) and "Load invitations" (driver view) panels with working
  Accept/Decline, wired to the backend built two rounds ago.
- **Customer sent-invitations tracking**: a "Track invitations"
  expansion on every row in "My Jobs & Loads," showing worker name,
  status, sent/expires/responded dates for that specific job or load.

## Schema diff this phase depends on

None. Phase 3 added zero schema changes — every field it needed
(`Assignment.expiresAt`/`respondedAt`, `CarrierRouteInvitation`'s
existing shape) was already in place from earlier rounds.

## How each required edge case is actually handled

Verified against the real backend code, not assumed:

| Case | Handling |
|---|---|
| **Duplicate invitation** | `upsert`, not an error — re-inviting the same worker to the same job/load (e.g. after a prior invitation expired) updates the existing row rather than colliding with the unique constraint. A deliberate design choice, not a rejection. |
| **Unauthorized user** | `requireRole` + ownership checks, `403`, surfaced verbatim in the UI. |
| **Ineligible worker** | Distinct messages per cause: `"Worker not found."`, `"Only mover accounts can be invited to moving jobs."`, `"This worker's account is not currently active."` |
| **Expired/closed opportunity** | `"Job is not accepting workers."` / `"Load is no longer open."` at invite time; `"This invitation has expired."` at accept time. |

The frontend doesn't branch UI per error type — it displays the
backend's specific message verbatim (`data.error`), which is genuinely
distinct and clear per case already, rather than adding a second,
parallel layer of message-writing in the frontend that could drift
from what the backend actually enforces.

## API reference (new this phase)

### `GET /api/jobs/{jobId}/invitations`
**Auth:** `CUSTOMER` (must own the job) or `ADMIN`.
**Response:** `{ invitations: [{ id, status, expiresAt, respondedAt, createdAt, worker: { id, displayName } }] }`
Statuses included: `INVITED`, `ACCEPTED`, `DECLINED`,
`CHECKED_IN`, `CHECKED_OUT`, `APPROVED`.

### `GET /api/loads/{loadId}/invitations`
**Auth:** `CUSTOMER` (must own the load) or `ADMIN`.
**Response:** same shape, `carrierRoute` in place of `job` context.

## Regression notes — static verification, not test execution

Same standing limitation as every phase before this one.

| Check | Result |
|---|---|
| TypeScript syntax check (per-file) | 176 files, 0 errors |
| Duplicate-declaration scanner | 183 files, 0 genuine duplicates |
| `schema.prisma` brace balance | Balanced (unchanged from Phase 2) |
| `package.json` JSON validity | Valid |

**What this does NOT confirm**: that the target picker's client-side
status filter (`POSTED`/`MATCHING`/`PARTIALLY_FILLED` for jobs,
`OPEN`/`OFFER_RECEIVED` for loads) exactly matches what a real
customer's job/load list looks like at scale, that the invitation
inbox panels render correctly against real (not hand-traced) API
responses, or that the four notification routes' `idempotencyKey`
values behave correctly under real concurrent webhook-adjacent retry
conditions — reasoned through, not executed.

## Deployment instructions for this phase

No new migration needed — Phase 3 has no schema changes.

```bash
npm ci
npx prisma generate
npx tsc --noEmit
npm run lint
npm test
npm run build
```

**Before this phase is genuinely production-ready:**
1. Run the commands above.
2. Manually verify the full workflow end-to-end in a real browser:
   post a job → search directory → invite a worker → sign in as that
   worker → accept → confirm the customer receives the acceptance
   notification → confirm the job progresses toward `CONFIRMED`.
3. Confirm the four new notification idempotency keys
   (`invitation-response:{id}:ACCEPTED`/`DECLINED`) actually prevent
   duplicate sends under a real retried request, not just by
   inspection of the key-generation logic.

## What's explicitly NOT in this phase

Freight-specific invitation *management* UI beyond what's built here
(bulk invitations, invitation templates) — Phase 4. Any messaging
surface between customer and worker — Phase 5. Analytics/reporting on
invitation conversion rates or marketplace activity — Phase 6.

**Phase 3.5 (Partner Organization Authorization Refactor)** — not
started. Scoped next, per the explicit direction to finish Phase 3
first.
