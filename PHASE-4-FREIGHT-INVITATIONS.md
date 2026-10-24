# TempMovers Marketplace — Phase 4: Freight Invitations

**Version:** v1-phase4-freight-invitations
**Roadmap position:** 4 of 6.5 (Marketplace Profile System → Preferred
Network Management → Choose Your Helper → Partner Organization
Authorization Refactor [3.5] → **Freight Invitations** → Messaging →
Analytics)
**Builds on:** Phase 3 (`inviteDriverToLoad`'s predecessor logic, the
single load-invitation route, worker/driver inboxes, accept/decline,
customer sent-invitation tracking), Phase 3.5 (partner authorization —
unchanged by this phase)

---

## What this phase delivers

The freight-specific invitation *management* layer Phase 3 explicitly
listed as "NOT in this phase — Phase 4": **bulk invitations** and
**reusable invitation message templates**. Phase 3 shipped one-driver,
one-load, default-message invitations end to end; Phase 4 makes a
customer able to invite many drivers at once and to save and reuse the
message they send.

No new invitation *model* for the invitations themselves — bulk invites
create the exact same `CarrierRouteInvitation` rows the single route
already created, via the same upsert, so everything downstream
(inboxes, accept/decline, tracking, assignment) works unchanged.

## New in this specific phase

### Backend

- **`inviteDriverToLoad` (`lib/loads/invite-driver.ts`)** — the
  eligibility → upsert → notify logic for one driver + one load,
  extracted from the Phase 3 single-invite route so the single and bulk
  paths share one implementation. Returns a discriminated result
  (`{ ok: true, invitationId, workerId }` | `{ ok: false, workerId,
  status, error }`) so the bulk caller can build a per-worker results
  array and the single caller can map straight to an HTTP status. The
  Phase 3 route now delegates to it; its request/response contract is
  unchanged.
- **`renderInvitationTemplate` (`lib/loads/invitation-template.ts`)** —
  pure token substitution, deliberately in its own db-free file so it's
  unit-testable without a generated Prisma client (same reasoning that
  isolated `post-load-schema.ts`). Tokens: `{driverName}`,
  `{loadTitle}`, `{pickupDate}`, `{expiresAt}`. Unknown tokens are left
  literal rather than silently dropped, so a customer's typo is visible
  instead of invisible.
- **`POST /api/loads/[loadId]/invitations/bulk`** — up to 25 driver IDs
  per call. Per-worker results array; one `LOAD_INVITATION_BULK_SENT`
  audit entry per batch. Load-level checks run once; per-worker
  eligibility runs per driver inside the loop.
- **Invitation templates CRUD** — `GET`/`POST
  /api/invitation-templates`, `PATCH`/`DELETE
  /api/invitation-templates/[templateId]`. Strictly owner-scoped,
  including for `ADMIN` (its own templates, not a cross-account view —
  no support workflow needs that yet, and building it speculatively
  would be scope creep).
- **`customLoadInvitationTemplate` (`lib/email/templates/booking.ts`)**
  — renders a saved template into the standard notification shape.
  HTML-escapes the customer-authored body and converts newlines to
  `<br>`; nothing else is treated as markup, so a template can't inject
  arbitrary HTML into an outgoing email.
- **Optional `templateId`** added to both the single and bulk invite
  request bodies. When present, the driver's notification uses the
  rendered template; when absent, the Phase 3 default
  `jobInvitationTemplate` is used exactly as before.

### Frontend (`components/DashboardApp.tsx`)

- Template dropdown in the single-invite modal (driver branch only).
- Driver-only bulk-select checkboxes on the Preferred Network roster,
  with a bulk-invite bar (pick template → pick one open load → send),
  and inline per-worker failure reporting keyed to the driver's name.
- A full invitation-template management panel (create / edit / delete),
  documenting the available tokens in-panel.

## Schema diff this phase depends on

**One new model — a migration IS required this phase** (unlike Phase 3,
which had none):

```prisma
model InvitationTemplate {
  id          String   @id @default(cuid())
  ownerUserId String
  owner       User     @relation(fields: [ownerUserId], references: [id], onDelete: Cascade)
  name        String
  subject     String
  body        String
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  @@index([ownerUserId])
}
```

Plus the reverse relation `invitationTemplates InvitationTemplate[]` on
`User`. No other model changed. Deliberately freight-only and
un-generic (no `jobId`/`loadId` FK, no template-type discriminator) —
every current caller is the load-invitation flow, and a speculative
generic "message templates" system nothing else uses would be scope
creep.

## How each required behavior is handled

Verified against the real backend code:

| Case | Handling |
|---|---|
| **Duplicate invitation (single or bulk)** | `upsert` on `@@unique([carrierRouteId, workerId])` — re-inviting refreshes the existing row, never a constraint collision. Identical between single and bulk because both call `inviteDriverToLoad`. |
| **Unauthorized user** | `requireRole(["CUSTOMER","ADMIN"])` + `postedByUserId` ownership check → `403`. Template routes additionally check `ownerUserId` on every read and write. |
| **Ineligible driver in a bulk batch** | Does not fail the batch — that one worker's result is `{ ok: false, error }`, the rest still send. Surfaced inline in the UI per driver. |
| **Closed/expired load** | Checked once for a bulk batch (whole batch fails identically → single `409`), and inside `inviteDriverToLoad` for the single path. |
| **Template not owned by caller** | `404 "Invitation template not found."` — same message for "doesn't exist" and "not yours," so ownership isn't leaked. |
| **Unknown token in a template** | Left literal (`{typo}`), never dropped. |

## Regression notes — static verification, plus one real unit run

Same standing limitation as every phase before this: no live Postgres,
no `prisma generate` (no network for the engine), no `npm test` (can't
install vitest), no `npm run build`.

| Check | Result |
|---|---|
| TypeScript syntax check (per-file) | 189 files, 0 errors |
| `schema.prisma` brace balance | Balanced |
| Duplicate-declaration scan (new symbols) | 0 duplicates |
| `renderInvitationTemplate` transpiled and executed under node | 8/8 assertions pass |

The last row is genuine runtime verification of the one piece of new
pure logic. Everything DB-bound is static analysis only.

**What this does NOT confirm:** that `Pick<CarrierRoute, ...>` compiles
against the real generated Prisma types (lower-risk than a
`GetPayload<>` generic, but unverified by a real compiler here); that a
full 25-driver bulk batch stays within request timeout against a real
database; that `tests/loads/invite-driver.test.ts` is picked up and
passes under vitest itself (its logic was verified out-of-band, the test
file has not been run by vitest).

## Deployment instructions for this phase

**A migration is required this phase** (`InvitationTemplate`).

```bash
npm ci
npx prisma generate
npx prisma migrate dev   # creates the InvitationTemplate table
npx tsc --noEmit
npm run lint
npm test
npm run build
```

**Before this phase is genuinely production-ready:**
1. Run the commands above; confirm the migration applies cleanly.
2. Save a template using every token → bulk-invite 3+ preferred drivers
   to one open load using it → confirm each driver receives the
   *rendered* (not raw-`{token}`) message, in both email and in-app.
3. Include one inactive/non-driver worker in a bulk selection and
   confirm the batch still sends to the eligible drivers while
   reporting that one as failed, inline, with a clear reason.
4. Confirm a customer cannot GET, edit, apply, or delete another
   customer's template (all four should `404`).

## What's explicitly NOT in this phase

Messaging/threaded conversation between customer and driver beyond the
one-shot invitation notice — Phase 5. Analytics on invitation
conversion or template effectiveness — Phase 6. Shared/team templates
across a partner org's members (templates are per-user, not
per-`PartnerOrganization`) — unscoped; the Phase 3.5 `PartnerMember`
model exists but no requirement yet ties templates to it.

## Roadmap status after this phase

Marketplace Profile System ✅ · Preferred Network Management ✅ ·
Choose Your Helper ✅ · Partner Organization Authorization Refactor ✅ ·
**Freight Invitations ✅** · Messaging (next) · Analytics.
