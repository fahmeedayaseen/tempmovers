# P0-06 — Consolidated Migration Plan

This document specifies exactly what the single consolidated Prisma migration
must contain, and the validation steps to run it. The migration FILE itself is
generated in an environment with a database (`npx prisma migrate dev`) — it is
NOT hand-written here, because Prisma's migration engine derives the exact DDL
(including foreign keys, indexes, and enum ordering) from a diff against the
database. This plan is the checklist to verify that generated file against.

## Why not a hand-written .sql here

The sandbox has no database and no network, so `prisma migrate diff`,
`prisma migrate dev`, `prisma generate`, and `prisma format` cannot run. A
hand-written full migration for 91 models / 80 enums would be unverifiable and
almost certainly wrong in FK ordering. Generate it against a real DB and check
it against the inventory below.

## New enums this engagement added (must be CREATE TYPE)

Compliance/market: FeatureFlagStatus (extended), MarketStage (RECONCILED — see
below), AccessorialServiceScope, AccessorialPricingShape, PlatformShareMode,
BookingAccessorialStatus.

Carrier onboarding: CarrierStatus, CarrierPaymentPreference,
CarrierDocumentType, InsuranceType, CarrierVerificationDecision.

Factoring: FactoringVerificationStatus, FactoringDocumentType,
PaymentAssignmentStatus, FactoringPartnerStatus, FactoringCommissionType,
FactoringReferralStatus.

Freight: FreightLoadStatus, CarrierOfferStatus, AccessorialKind,
AccessorialApprovalStatus, CustomerInvoiceStatus, CarrierSettlementStatus.

## New models this engagement added (must be CREATE TABLE)

Market: MarketChangeLog. (LaunchMarket gains 6 service-control columns +
alters the stage enum — see reconcile.)

Carrier: Carrier, CarrierDocument, CarrierInsurancePolicy, CarrierEquipment,
CarrierLane, CarrierAgreement, CarrierFmcsaCheck, CarrierStatusEvent.

Factoring: CarrierFactoringProfile, FactoringDocument, PaymentAssignment,
PaymentRoutingAudit, FactoringPartner, FactoringReferral.

Freight: FreightLoad, FreightStop, LoadFinancialAmendment, CarrierOffer,
RateConfirmation, LoadAccessorial, CustomerInvoice, CarrierSettlement,
FreightAuditEvent.

Accessorials (earlier phase): AccessorialType, AccessorialMarketPrice,
BookingAccessorial.

Also: CARRIER + FINANCE_ADMIN + SUPER_ADMIN added to UserRole; FeatureFlag
columns (status, enabled*, configuration); fee-model + MANUAL_IMPORT-related
columns on CarrierRoute; the 8 brokerage flags are DATA (FeatureFlag rows), not
schema — seed them DISABLED.

## The one migration that needs care: MarketStage reconcile

`prisma/migrations/manual/market_stage_reconcile.sql` already contains the
SAFE, explicit-mapping version (PIPELINE→PLANNING, SUPPLY_BUILD→
CARRIER_RECRUITMENT, CONTROLLED_LAUNCH→SOFT_LAUNCH, EXPANSION_READY→ACTIVE,
PAUSED→PAUSED; adds COMING_SOON, CLOSED). When Prisma generates its own version
of this enum change, RECONCILE the generated file against that mapping — Prisma
may emit a drop/recreate that would lose data. The explicit CASE mapping is the
part that must survive.

## Generation + validation sequence (run in a DB environment)

1. `npx prisma migrate diff --from-schema-datasource --to-schema-datamodel`
   to preview, or `npx prisma migrate dev --name consolidated_platform` on a
   clean dev DB to generate the migration.
2. Reconcile the generated MarketStage step with the manual reconcile SQL.
3. Apply to a CLEAN database — confirm it creates every enum + table above.
4. Apply to a COPY of the current STAGING database — confirm it maps existing
   LaunchMarket rows without loss and doesn't conflict with legacy freight
   models (CarrierRoute, Settlement).
5. `npx prisma generate` — confirm the client builds.
6. `tsc --noEmit` (or the project's typecheck) — confirm types compile.
7. `next build` — confirm the production build succeeds.
8. Run unit + integration tests (`vitest`), including the freight suite.
9. Confirm all 8 brokerage flags resolve to OFF (no ENABLED FeatureFlag rows).
10. Confirm legacy + new freight models coexist (no table/enum name clash).

## Acceptance-criteria coverage confirmed at the code level (this phase)

- #1 invalid load-status transitions rejected — canTransitionLoad (tested).
- #2 money in cents — computeLoadFinancials throws on fractional (tested).
- #3 two carriers can't accept the same load — atomic conditional updateMany
  in offers/accept (RACE_LOST 409).
- #4 every freight endpoint compliance-gated — verified: all 8 routes call
  assertFreightAllowed / assertBrokerageAllowed.
- #5 eligibility rechecked at offer accept + assignment — getCarrierEligibility
  in accept + rate-confirmation + offer creation.
- #6 material rate changes version — RateConfirmation version increments;
  LoadFinancialAmendment @@unique([loadId,version]).
- #7 POD upload != approval — separate POST (upload) and PATCH (approve).
- #8 accessorials need documented approval — 428 without supporting document.
- #9 duplicate invoices/settlements prevented — invoiceNumber @unique,
  creationKey @unique, settlement @@unique([loadId]).
- #10 verified factoring controls settlement routing — settlement pulls
  remitTo from the ACTIVE assignment, never carrier input.
- #11 blocking payment exception prevents payout — hasBlockingPaymentException
  gate in settlement prep (428).
- #12 audit append-only — FreightAuditEvent written in every mutation tx.
- #13 idempotent retries — creationKey unique on load/invoice/settlement.

Still requiring the live DB (this document's whole point): #14 migration
succeeds against a real test database, and #15 end-to-end load→settlement tests.
