# TempMovers Marketplace — Phase 3.5: Partner Organization Authorization Refactor

**Version:** v1-phase3.5-partner-auth-refactor
**Roadmap position:** 3.5 of 6.5 (inserted between Choose Your Helper
and Freight Invitations, per explicit direction)

---

## What this phase delivers

A single, shared authorization model for every partner-organization-
scoped route in the codebase — closing the gap found during Phase 2's
review: `PartnerMember` (role, `canApprove`, `canPostJobs`) has existed
in the schema since long before this engagement, completely unused
anywhere. Every partner route checked only the single owning
`CustomerProfile`, meaning a partner org with a real team had no way
for anyone but that one account to do anything.

## Scope — precisely, not by assumption

Before touching anything, every route referencing partner or job
ownership was audited and split into two genuinely different
categories:

- **Job/assignment ownership** (`job.customer.userId`,
  `assignment.job.customer.userId`) — 8 routes. These check whether a
  job belongs to the individual customer who posted it, which has
  nothing to do with `PartnerOrganization` or `PartnerMember` at all.
  **Correctly left unchanged** — migrating these would have been
  scope creep against a problem that doesn't exist for them.
- **Partner organization ownership** (`partner.customer.userId`) — the
  actual target. **3 route files, 4 call sites**: `worker-directory`
  (read), `billing` (read), `invoices` (read + write, two separate
  handlers).

Confirmed via `grep -rn "partner.customer.userId"` across the whole
`app/api` tree after migration: **zero remaining matches.**

## What changed in `lib/partner-permissions.ts`

Two real fixes made to the helper itself while migrating callers onto
it, beyond just wiring it up more places:

1. **The helper now returns the fetched partner object on success**,
   not just an allowed/denied boolean. Every migrated caller had
   previously done a second, redundant `findUnique` for the same row
   immediately after its own ownership check — this removes that
   duplicate fetch everywhere, not just in one route.
2. **A real bug fixed, found while doing this**: the prior version
   returned `allowed: true` for an `ADMIN` caller *before* ever
   checking whether the partner existed at all. An admin querying a
   nonexistent `partnerId` would have gotten a false "allowed,"
   pushing a confusing null-partner failure downstream in the caller
   instead of a clean `404` here. Both functions now check existence
   first, for every role, including `ADMIN`.

**A mistake caught mid-refactor, worth naming directly**: the first
draft of the shared partner-object type used
`Prisma.PartnerOrganizationGetPayload<{...}>` — a generic Prisma type
extraction. Given the exact same class of risk documented already in
`lib/freight-claim.ts` (this sandbox can't fully verify such generics
compile correctly without the real generated Prisma client), it was
replaced with a plain, explicit object type instead. That type was
then found to be missing fields **twice** while actually migrating
callers — `displayName` (used in the billing route's response) and
`customer.id` (used in the invoices route for
`ensureStripeCustomer`) — each found by grepping every actual `partner.`
usage in the route being migrated *before* assuming the type was
sufficient, not after something broke.

## Schema diff this phase depends on

None. `PartnerMember` already existed with everything this refactor
needed (`role`, `canApprove`, `canPostJobs`, the
`@@unique([partnerId, userId])` constraint the lookup relies on).

## Regression notes — static verification, not test execution

Same standing limitation as every phase before this one.

| Check | Result |
|---|---|
| TypeScript syntax check (per-file) | 176 files, 0 errors |
| Duplicate-declaration scanner | 183 files, 0 genuine duplicates |
| `schema.prisma` brace balance | Balanced (unchanged) |
| Comprehensive `partner.customer.userId` grep | 0 remaining matches |

**What this does NOT confirm**: that a real `PartnerMember` row with
`role: "manager"` (lowercase) or similar actually grants access as
intended — the case-insensitive match is written correctly but never
executed against real data. That the plain `Record<string, unknown>`
fallback in `PartnerWithCustomer`'s type doesn't silently mask a third
missing-field issue the same way the first two were found — the type
is now correct for every field actually used by the 3 migrated routes,
verified by grep, not by a real compiler checking every possible
future usage.

## Deployment instructions for this phase

No new migration needed.

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
2. Create a real `PartnerMember` row for a test partner org with each
   of `canApprove: true`, `role: "manager"` (and case variants), and a
   plain `MEMBER` with neither, and confirm read/write access resolves
   correctly for all three against the real database.
3. Confirm the ADMIN-existence-check fix actually returns `404` for a
   nonexistent `partnerId` end-to-end, not just by reading the code.

## What's explicitly NOT in this phase

No new UI for managing `PartnerMember` rows themselves (inviting a
teammate to a partner org, assigning them a role) — this phase closed
the *authorization* gap for routes that already exist; building the
management UI for the underlying membership model is separate,
unscoped work. No migration of the 8 job/assignment-ownership routes,
since they were confirmed correctly out of scope for this refactor.

## Roadmap status after this phase

Marketplace Profile System ✅ · Preferred Network Management ✅ ·
Choose Your Helper ✅ · **Partner Organization Authorization Refactor
✅** · Freight Invitations (next) · Messaging · Analytics.
