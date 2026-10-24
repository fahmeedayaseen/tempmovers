# TempMovers Marketplace — Phase 2: Preferred Network Management

**Version:** v2-phase2-preferred-network
**Roadmap position:** 2 of 6 (Marketplace Profile System → **Preferred
Network Management** → Choose Your Helper → Freight Invitations →
Messaging → Analytics)
**Builds on:** Phase 1 (`WorkerProfileCard`, `SAFE_WORKER_SELECT`,
worker directory)

---

## What this phase delivers

A real frontend for the `PreferredWorker` CRUD backend that existed
with no UI until now. A business can search the worker directory
(Phase 1), add a worker to its preferred network directly from a
profile card, and manage the resulting roster — reorder by priority,
remove entries — without touching an API client.

## New in this specific phase

### Frontend only — no new backend routes

Every route this phase uses (`GET`/`POST /api/partners/[partnerId]/
preferred-workers`, `PATCH`/`DELETE .../preferred-workers/[workerId]`)
was already built and verified in the prior development round. This
phase is entirely about connecting real UI to that already-correct
backend, which is why it shipped without any schema changes.

- **"Add to preferred network" action** on every `WorkerProfileCard` in
  the directory search results — disabled and labeled "Already
  preferred" for a worker already on the roster, rather than allowing
  a duplicate-add attempt the backend would just reject anyway.
- **"My preferred network" panel** — the roster itself: worker name,
  type, an editable priority field (calls `PATCH` on change), date
  added, and a Remove action. The remove confirmation message states
  plainly that it only affects future opportunities, matching the
  backend's own documented behavior — historical assignments are
  never touched.

## Schema diff this phase depends on

None. Phase 2 added zero schema changes — it consumes
`PreferredWorker` exactly as it existed after the prior round
(including the `createdAt` field added then, now surfaced in the UI's
"Added" column for the first time).

## API reference (consumed this phase, not newly built)

### `GET /api/partners/{partnerId}/preferred-workers`
Returns `{ preferredWorkers: [{ id, priority, createdAt, worker: <SAFE_WORKER_SELECT> }] }`.

### `POST /api/partners/{partnerId}/preferred-workers`
Body: `{ workerId, priority? }`. `409` if already on the roster.

### `PATCH /api/partners/{partnerId}/preferred-workers/{workerId}`
Body: `{ priority }`.

### `DELETE /api/partners/{partnerId}/preferred-workers/{workerId}`
Removes the roster entry only — never touches historical
`Assignment`/`CarrierRouteInvitation` records for that worker.

All four: `CUSTOMER` (must own the partner org) or `ADMIN`, every
add/priority-change/removal audit-logged (verified present in the
route source, not re-verified here since the routes themselves are
unchanged this phase).

## Regression notes — static verification, not test execution

Same standing limitation as Phase 1 — nothing below was executed.

| Check | Result |
|---|---|
| TypeScript syntax check (per-file) | 174 files, 0 errors |
| Duplicate-declaration scanner | 181 files, 0 genuine duplicates |
| `schema.prisma` brace balance | Balanced (unchanged from Phase 1) |
| `package.json` JSON validity | Valid |

**What this does NOT confirm**: that `preferredWorkers?.some(pw =>
pw.worker.id === w.id)` (the "already preferred" check) actually
matches correctly at runtime against real API data shapes — it's
written to match the documented response shape exactly, but has never
run against a live response. That a priority edit's `onChange` firing
on every keystroke (rather than on blur or an explicit save) doesn't
cause excessive `PATCH` traffic under real use is a UX question worth
revisiting with real usage data, not a defect, but worth flagging as a
deliberate simplicity-over-polish choice for this phase.

## Deployment instructions for this phase

No new migration needed — Phase 2 has no schema changes.

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
2. Manually verify the priority `<input type="number">` behaves
   correctly in a real browser — number inputs have known
   cross-browser quirks around empty values and decimal entry that a
   syntax check cannot catch.
3. Consider debouncing the priority-change handler before this sees
   real traffic, per the note above.

## Corrections applied after a formal Phase 2 developer handoff review

A written handoff reviewed this phase against its own acceptance
criteria and found real gaps beyond what the initial delivery covered.
Each is a genuine fix, not a restatement:

### 1. A real, pre-existing authorization gap — bigger than Phase 2 alone
The handoff asked to "restrict write access to Owner/Admin/Manager."
Checking this directly revealed `PartnerMember` (role, `canApprove`,
`canPostJobs`) has existed in the schema, **completely unused,
anywhere in this entire codebase** — every partner-scoped route ever
built (this phase's preferred-network routes, but also billing,
invoicing, settlements from earlier rounds) checked only the single
owning `CustomerProfile`, never `PartnerMember` at all. A partner
organization with multiple team members had no way for anyone but the
one owning account to do anything.

**Fixed for this phase specifically**: `lib/partner-permissions.ts` —
`resolvePartnerWriteAccess()` (owning customer, or a `PartnerMember`
with `canApprove: true` or a role of OWNER/ADMIN/MANAGER) and
`resolvePartnerReadAccess()` (any partner member, deliberately
broader — viewing shouldn't require write permission). Wired into all
three preferred-worker routes, replacing the ownership-only check.

**Stated plainly**: this same gap almost certainly exists in every
other partner-scoped route from earlier rounds. Fixing those is out of
scope for this phase and not attempted here — flagged for a dedicated
pass, not silently left for someone to rediscover.

### 2. Missing UI requirements, now built
- **Preferred status badge** — previously only conveyed via disabled
  button text ("Already preferred"). `WorkerProfileCard` now takes an
  `isPreferred` prop and renders a real visual badge.
- **Availability display** — `acceptingJobs` added to
  `SAFE_WORKER_SELECT` (a worker-controlled boolean, safe to show
  directly) and rendered on every card and in the roster table.
  `operationalStatus` itself stays excluded — still compliance-
  sensitive detail; "eligibility" is satisfied by the directory's
  existing `ACTIVE`-only filter, not by exposing a raw status string.
- **"Open worker public profile"** — the Phase 1 `GET
  /api/workers/[workerId]/profile` endpoint had no frontend caller at
  all until now. A "View profile" action on every card opens a real
  panel with the full card plus recent review highlights.
- **Search and filter the roster itself** — the initial delivery only
  added search to the directory, not to the preferred-network list
  itself. Added client-side name/type filtering to the roster table
  (client-side deliberately, not a new endpoint — a business's own
  roster is a small, already-fully-loaded list, not something that
  benefits from server-side pagination the way the directory does).
- **Controlled duplicate responses** — the backend's 409 now includes
  `code: "DUPLICATE_PREFERRED_WORKER"`, and the frontend checks it
  explicitly rather than pattern-matching an error message string.

**Files (corrections):** `lib/partner-permissions.ts` (new),
`lib/access/sanitize-worker.ts`,
`app/api/partners/[partnerId]/preferred-workers/route.ts`,
`app/api/partners/[partnerId]/preferred-workers/[workerId]/route.ts`,
`components/WorkerProfileCard.tsx`, `components/DashboardApp.tsx`

**Regression after corrections**: 175 files, all clean; 182 files, 0
genuine duplicates. Same static-verification-only limitation as
everywhere else in this document.

## What's explicitly NOT in this phase

Inviting a preferred worker directly to a specific job or load (Phase
3 — "Choose Your Helper"), any freight-specific invitation UI (Phase
4), messaging (Phase 5), analytics (Phase 6). A business can now curate
*who* they prefer; acting on that preference by inviting them to real
work is the next phase's deliverable, not this one's.


