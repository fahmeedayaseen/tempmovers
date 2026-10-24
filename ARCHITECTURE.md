# TempMovers Architecture

## Recommended deployment

- Next.js frontend and API routes
- PostgreSQL with PostGIS
- Prisma ORM
- Stripe Billing + Stripe Connect
- S3-compatible document storage
- Google Maps or Mapbox
- Background jobs through Inngest, Trigger.dev, or a queue
- Sentry for application monitoring

## Money flow

### Mover subscription
Mover → Stripe Checkout → TempMovers platform account  
Recurring charge: $19.95/month.

### Customer moving job
Customer authorizes:
- Base mover earnings
- $5 TempMovers fee per mover-hour
- Urgent premium, if applicable

After the job:
- Approved actual hours replace estimated hours
- Customer charge is captured
- Worker earnings are transferred through Stripe Connect
- TempMovers retains the hourly platform fee
- Tips transfer fully to workers

## Important pricing example

Two movers, three-hour minimum, each earning $32/hour:

- Mover labor: 2 × 3 × $32 = $192
- TempMovers fee: 2 × 3 × $5 = $30
- Customer total before premiums/tax: $222
- Each mover earns: $96
- TempMovers earns: $30

## Geo-targeting

Use PostGIS geography fields and queries such as:
- Workers within radius of job point
- Worker territory intersects job ZIP/county/state
- Available during job window
- Qualified for required skills
- Active subscription and payout-ready Stripe account
- Proper vehicle type for driver routes

## Security

- Never trust client-calculated totals
- Recalculate quotes server-side
- Verify Stripe webhook signatures
- Enforce role checks on every API route
- Encrypt sensitive document references
- Never store full card or bank details
- Keep immutable payment, payout, and time audit records

## Driver pricing implementation

### Driver Basic
$29.95/month for drivers operating equipment owned by another company.

### Owner-Operator Pro
$59.95/month for box-truck and semi owner-operators, including vehicle and compliance records.

### Fleet
$149/month for five vehicles, plus $15/month for each additional vehicle.

### Box-truck transaction
The driver gross is preserved. TempMovers adds $5 for every completed route-hour to the customer invoice.

Example: eight hours at $60/hour produces $480 driver gross, $40 TempMovers revenue, and a $520 customer total.

### Semi transaction
TempMovers adds 5% of the carrier gross to the shipper total, limited to $150 per load.

Examples:
- $600 carrier gross -> $30 fee
- $2,000 carrier gross -> $100 fee
- $5,000 carrier gross -> $150 capped fee

The database stores the fee model, gross amount, percentage, cap, and final platform fee so historical transactions remain auditable when pricing changes later.

## Scheduled, urgent, and protection pricing

Moving-labor quotes are calculated from man-hours:

`manHours = max(2, movers) × max(3, hours)`

- Scheduled fee: `manHours × $5`
- Urgent hourly-fee mode: `manHours × $7`
- Optional urgent percentage mode: scheduled man-hour fee plus a market-configurable percentage premium
- Booking protection: $9.95 per moving job

All totals are recalculated on the server before Stripe authorization. Stripe metadata records man-hours, fee per man-hour, total platform fee, booking-protection fee, and urgent-fee mode.

## First-paid-job subscription waiver

New movers can accept and complete their first paid job before the $19.95 monthly membership begins. The worker record stores the first completed-job timestamp and waiver status. After first completion, the platform should prompt the mover to activate Stripe Billing before accepting additional jobs. Production authorization middleware must enforce that rule server-side.


## Bonus controls

Bonus awards are ledgered separately from worker earnings. Qualification must be based on completed, non-refunded paid activity. Use idempotent award creation, one award per program/qualifying entity, admin approval, fraud review, and Stripe transfer metadata. Keep regulated freight flags disabled until required authority and legal review are complete.
