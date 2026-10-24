# Market Authorization — Per-Route Inventory (Phase 2)

Documented map of every market-touching route, classified as **admin-scoped**
(an admin acting on records they don't own → must call `requireMarketAccess`)
or **owner-scoped** (customer/worker/partner self-service → protected by
existing ownership checks, market auth intentionally NOT applied).

Principle (approved): market authorization is an ADMIN concept. Apply it only
where an administrator operates on records they do not personally own. Leave
self-service flows on their ownership checks (least privilege, least surprise).

## Admin-scoped routes — market auth applied

| Route | Roles | Market source | Status |
|---|---|---|---|
| `admin/pricing` | ADMIN/SUPPORT/FINANCE/SUPER | `marketCode` → LaunchMarket (national ⇒ PLATFORM) | ✅ done (Group 1) |
| `admin/accessorial-prices` | ADMIN/FINANCE/SUPER | `marketId` (null ⇒ PLATFORM) | ✅ done |
| `jobs/[jobId]/accessorials` | ADMIN/SUPPORT/FINANCE/SUPER | `job.marketId` (null ⇒ 403) | ✅ done |
| `loads/[loadId]/accessorials` | ADMIN/SUPPORT/FINANCE/SUPER | `load.originMarketId` (null ⇒ 403) | ✅ done |
| `settlements` (+ preview) | ADMIN/FINANCE/SUPER | per-load `originMarket`, partial-by-scope | ✅ done (Option 3) |

## Owner-scoped routes — market auth intentionally NOT applied

These are self-service: the actor owns the record, and an ownership check
already restricts access. Adding market auth would be wrong (the actor isn't
an admin with market assignments) or redundant.

| Route | Roles | Why owner-scoped |
|---|---|---|
| `jobs/route.ts` (POST) | CUSTOMER/ADMIN | customer posts their OWN job |
| `jobs/[jobId]/assignments` | CUSTOMER/ADMIN/MOVER | `job.customer.userId === authed.userId` check |
| `loads/route.ts` (POST) | CUSTOMER/ADMIN | customer/partner posts their OWN load |
| `loads/[loadId]/request` | DRIVER | driver requests a load for themselves |
| `assignments/[id]/accept` | MOVER | mover accepts their OWN assignment |
| `driver/loads`, `driver/territories` | DRIVER/MOVER | driver's own scope |
| `partners/[partnerId]/recommended-workers` | CUSTOMER/ADMIN | scoped by partner ownership |
| `partners/[partnerId]/worker-directory` | CUSTOMER/ADMIN | scoped by partner ownership |
| `quotes`, `auth/register` | none/public | no market ownership concept |

## Notes & edge cases

- **ADMIN can appear in owner-scoped routes** (e.g. an admin posting a job on
  a customer's behalf). Those routes keep their existing role/ownership logic;
  if a future requirement needs admins there constrained by market, that's a
  deliberate follow-up, not part of this pass.
- **Fail closed:** admin routes acting on a record with no resolvable market
  return 403 rather than allowing the action.
- **National/default config** (marketCode/ marketId null) requires PLATFORM
  scope, not a market/state assignment.
- **Reports:** the only "reports" routes are portfolio moderation
  (`admin/portfolio/reports/*`), which are not market-scoped (they act on
  media reports, not market records), so no market auth applies. If
  market-scoped financial/operational reporting is added later, it joins the
  admin-scoped list.
- **Worker/Partner administration:** no dedicated admin worker/partner
  *mutation* routes currently resolve a market; `partners/[partnerId]/*` are
  owner-scoped reads. When admin worker/partner management routes are added,
  they should call `requireMarketAccess` on the relevant market.

## Coverage verdict

All CURRENTLY EXISTING admin-acting-on-others routes that resolve a market are
now wired to `requireMarketAccess`. No owner-scoped route was changed. Future
admin routes must call the helper (engineering standard).
