# TempMovers Marketplace — Phase 5: Marketplace Profiles, Reputation & Discovery

**Version:** v1-phase5-profiles-reputation-discovery (SPEC — not yet built)
**Roadmap position:** 5 of 8 (Marketplace Profile System → Preferred
Network Management → Choose Your Helper → Partner Org Authorization
Refactor [3.5] → Freight Invitations [4] → **Profiles, Reputation &
Discovery** → Portfolio Media & Moderation [5.5] → Messaging &
Notifications [6] → Analytics & Reporting [7] → Production Readiness [8])
**Builds on:** Phase 1 (`WorkerProfileCard`, `SAFE_WORKER_SELECT`,
`GET /api/workers/[workerId]/profile`, worker directory), Phase 2
(Preferred Network), Phase 3–4 (invitation workflows)

---

## Prime directive: reuse, do not rebuild

Phase 5 makes the marketplace richer to **browse and evaluate**. It must
extend the existing surfaces, not create parallel ones. Specifically:

- **`components/WorkerProfileCard.tsx`** is THE worker-summary component.
  Every new discovery/search/recommendation surface renders workers
  through it. Do not build a second card.
- **`lib/access/sanitize-worker.ts`'s `SAFE_WORKER_SELECT`** is THE
  public field list. Any new field shown to a business (skills,
  certifications, languages, metrics) is added HERE first, then flows to
  every route automatically — never fetched ad hoc in one route. The
  existing "add a field here, not per-route" leak-prevention comment is
  the contract.
- **`GET /api/workers/[workerId]/profile`** is THE single-worker profile
  endpoint. Expanded profiles extend its response; no new profile route.
- **The worker directory route**
  (`app/api/partners/[partnerId]/worker-directory`) is THE discovery
  entry point. Advanced filtering/sorting extends its query schema and
  `where`/`orderBy`; no new search route unless a genuinely distinct
  concern (saved searches, favorites) needs its own resource.
- **Preferred Network (Phase 2) and the invitation workflows (Phase 3–4)**
  are reused as-is for "preferred worker discovery" and the invite
  actions on every new surface.

A reviewer should be able to confirm Phase 5 added zero duplicate
profile/card/directory components.

## Scope — included

### 1. Expanded mover & driver profiles

Add to the profile/`SAFE_WORKER_SELECT` surface:

- **Skills / experience** — the `WorkerSkill[]` ↔ `Skill` relation
  ALREADY EXISTS in the schema and is currently unused by any
  business-facing read. Phase 5 surfaces it; it does not invent it. Add
  `skills` to `SAFE_WORKER_SELECT` and render on the card/profile.
- **Certifications** — NEW. Needs a model (see schema diff). Distinct
  from skills: a certification has an issuer and optional expiry;
  a skill is a free tag. Do not overload `Skill` for this.
- **Languages** — NEW, lightweight. A `WorkerLanguage` join or a
  string array; a join is preferred for filterability (see discovery).
- **Equipment details** — the `vehicles` relation is ALREADY in
  `SAFE_WORKER_SELECT` (type, liftgate, pallet jack, capacity). Phase 5
  only enriches presentation; no new fetch.
- **Safe availability signals** — the `Availability[]` relation
  (`startsAt`/`endsAt`/`isAvailable`) ALREADY EXISTS and is unused by
  reads. Surface a DERIVED, coarse signal only ("available this week" /
  next open window), NOT the raw calendar. `acceptingJobs` (already in
  `SAFE_WORKER_SELECT`) remains the primary worker-controlled boolean.
  Never expose home address, exact ZIP, or precise location as an
  "availability" proxy — `SAFE_WORKER_SELECT`'s exclusion list stands.

### 2. Reputation

- **Rating summaries** — `ratingAverage`, `ratingCount`,
  `fiveStarReviewCount` are ALREADY maintained on `WorkerProfile` by
  `lib/reviews.ts` (recalculated on every review submit/moderate, so
  they can't drift from PUBLISHED reviews). Phase 5 SURFACES these
  richer summaries; it does not recompute or re-store them.
- **Verified-job customer reviews** — `Review` is FK'd to a real
  `jobId` with `@@unique([jobId, workerId])`. Every review is therefore
  already tied to a real completed job by construction — "verified-job"
  is a display treatment (badge/label) over existing data, plus
  filtering to `status: PUBLISHED`. No schema change required for the
  "verified" property itself.
- **Metrics — ONLY where the source data supports a reliable
  calculation.** Audited against the real schema (see "Metric
  reliability audit" below). Ship the green ones; do NOT ship a metric
  the data can't support just to complete the list.

### 3. Advanced discovery

- **Filtering** — extend the directory `querySchema`: by skill,
  certification, language, worker type (exists), market (exists),
  minimum rating, verified-only, accepting-jobs-only, availability
  window. All added to the existing `where`, all constrained to
  `SAFE_WORKER_SELECT`-safe fields.
- **Sorting** — extend with an `orderBy` param: rating, completed jobs,
  response time (if shipped), recently active. Default sort documented.
- **Preferred / favorite / recently-hired discovery**:
  - *Preferred* — reuse Phase 2 `PreferredWorker` (exists).
  - *Favorite* — NEW `FavoriteWorker` model (customer-scoped bookmark,
    distinct from PreferredWorker which is partner-org-scoped and
    priority-ranked). A favorite is a lightweight personal star; a
    preferred-network entry is an operational roster. Keep them
    separate.
  - *Recently hired* — DERIVED from existing `Assignment` rows
    (customer's jobs → assigned workers, most recent first). No new
    model; it's a query over data that already exists.
- **Saved searches** — NEW `SavedSearch` model (owner + serialized
  filter params + name). Re-running a saved search just replays the
  params against the directory route; the saved row stores criteria,
  never a cached result set.
- **Recommended / similar workers — transparent rules only.** No opaque
  scoring model. Recommendations must be explainable in one sentence the
  UI can actually show, e.g. "same market + same worker type + rating ≥
  4.5, not already in your network" or "workers similar to one you
  recently hired (shared skills + market)." The rule is displayed to the
  customer. If a rule can't be stated plainly, it doesn't ship.

## Scope — explicitly excluded

Deferred, by explicit direction:

- Worker portfolio / public photo uploads → **Phase 5.5** (see below).
  Note `WorkerProfile.profilePhotoUrl` already exists as a field, but
  populating it safely from user uploads is the whole point of 5.5 —
  Phase 5 may DISPLAY an already-set `profilePhotoUrl` but must not add
  an upload path for it.
- Upload moderation workflows → Phase 5.5.
- Featured placement / paid ranking → not without separate approval.
  Recommendations in Phase 5 are rule-based and unpaid; nothing sells
  ranking position.
- Partner dashboard analytics, invitation-conversion reporting, team
  performance dashboards, broad marketplace analytics → **Phase 7**.
  This is the seam that keeps Phase 5 = "browse & evaluate" and
  Phase 7 = "measure." Search-to-profile and profile-to-invite
  conversion, saved-search performance, and hiring-history *analysis*
  all belong to Phase 7 — Phase 5 builds the features those metrics
  will later measure, not the measurement.

## Metric reliability audit (the conditional in "provided the data exists")

Verified field-by-field against `prisma/schema.prisma`. This is the
part of the scope that is conditional, so it is spelled out rather than
assumed:

| Metric | Source data | Verdict |
|---|---|---|
| **Rating summary** (avg, count, 5-star count) | `WorkerProfile.ratingAverage` / `ratingCount` / `fiveStarReviewCount`, maintained by `lib/reviews.ts` | **SHIP.** Already stored and authoritative. |
| **Verified-job reviews** | `Review.jobId` FK + `@@unique([jobId, workerId])`, `status` | **SHIP.** Every review is already job-verified by construction; filter to `PUBLISHED`. |
| **Completion rate** | `Assignment.status`: completed = `APPROVED`/`CHECKED_OUT`; not-completed = `CANCELED`/`NO_SHOW` | **SHIP, with a stated definition.** Reliable, but the numerator/denominator definition (does `DECLINED` count against? almost certainly not — a decline is not a failure) must be written down and applied consistently. Recommend: rate = completed ÷ (completed + NO_SHOW + worker-initiated CANCELED). Exclude DECLINED and INVITED. |
| **Response time** | `Assignment.createdAt` (invited) → `respondedAt` | **SHIP.** Both timestamps exist; median response latency is a clean calculation. Use median, not mean (one stale invite skews a mean badly). |
| **On-time rate** | `Job.startsAt` (scheduled) vs `Assignment.checkInAt` (actual) | **SHIP ONLY AS A CLEARLY-LABELED PROXY, or DEFER.** `checkInAt` exists and `startsAt` exists, so a proxy is computable — but `startsAt` is the job's scheduled start, not a per-worker "expected on site" time, and there's no explicit expected-arrival field. Presenting this as a precise "on-time rate" would overstate what the data means. RECOMMENDATION: either label it exactly as "checked in by scheduled job start" (honest about what it measures) or defer on-time until an explicit expected-arrival field exists. Do not ship it as an unqualified "on-time %." |

**The rule for the team:** a metric ships only if its definition can be
stated in one honest sentence next to the number. Anything that needs a
footnote to not be misleading gets the footnote or gets deferred.

## Schema diff this phase depends on

New models (migration required):

- `Certification` — `workerId`, `name`, `issuer?`, `issuedAt?`,
  `expiresAt?`, verification status. Distinct from `Skill`.
- `WorkerLanguage` — `workerId` + language code (join for filterability).
- `FavoriteWorker` — `customerUserId`, `workerId`, `createdAt`,
  `@@unique([customerUserId, workerId])`. Customer-scoped, distinct from
  `PreferredWorker`.
- `SavedSearch` — `ownerUserId`, `name`, serialized filter params
  (JSON), `createdAt`. Stores criteria, never results.

Reused with NO change: `WorkerSkill`/`Skill`, `Availability`, `Review`,
`Assignment`, `PreferredWorker`, `Vehicle`, all rating fields.

`SAFE_WORKER_SELECT` gains: `skills`, `certifications`, `languages`, and
any derived-metric fields exposed via the profile endpoint (metrics
computed in a helper, not necessarily stored columns).

## What NOT to do (anti-patterns specific to this phase)

- Do not store computed metrics as denormalized columns unless there's a
  measured performance reason — compute completion/response in a helper
  (mirroring how `lib/reviews.ts` is the single owner of rating fields).
  Rating fields are the exception because review moderation makes
  recompute-on-write genuinely necessary.
- Do not expose the raw `Availability` calendar or any location field as
  an "availability signal." Derived coarse signal only.
- Do not let "recommended workers" become an unexplained score. If the
  UI can't show the reason, the rule is wrong for this phase.
- Do not add an upload path for `profilePhotoUrl` — that's 5.5.

## Deployment instructions (when built)

A migration IS required (four new models).

```bash
npm ci
npx prisma generate
npx prisma migrate dev
npx tsc --noEmit
npm run lint
npm test
npm run build
```

**Before production-ready:**
1. Commands above; confirm migration applies.
2. Confirm every new business-facing field is reached through
   `SAFE_WORKER_SELECT`, not a one-off select — grep for direct
   `workerProfile.findMany`/`findUnique` selects that bypass it.
3. Confirm each shipped metric's on-screen definition matches its actual
   calculation (especially completion-rate's numerator/denominator and
   whatever on-time is labeled as).
4. Confirm recommendation rules display their reason.
5. Confirm no `Availability` raw calendar or location leaks through any
   new response.

## What's explicitly NOT in this phase → where it goes

- Public portfolio media + moderation → **Phase 5.5 — Portfolio Media &
  Moderation** (file type/size limits, presigned auth, private staging
  before publish, malware/unsafe-file scanning, image moderation, admin
  review/removal, user reporting, storage quotas & cost controls,
  retention/deletion, audit logging, safe public delivery URLs, UGC
  terms & consent). Called out separately precisely because it is more
  than wiring the existing upload API.
- All measurement/analytics/dashboards (invitation conversion,
  preferred-network performance, hiring-history analysis, team
  performance, funnel reporting, search→profile & profile→invite
  conversion, saved-search performance, business/admin dashboards) →
  **Phase 7 — Analytics & Reporting.**
- Messaging between customer and worker → **Phase 6.**

## Roadmap status after this phase (planned)

Marketplace Profile System ✅ · Preferred Network ✅ · Choose Your
Helper ✅ · Partner Org Authorization Refactor ✅ · Freight
Invitations ✅ · **Profiles, Reputation & Discovery (this phase)** ·
Portfolio Media & Moderation [5.5] · Messaging [6] · Analytics [7] ·
Production Readiness [8].
