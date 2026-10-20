# Commercial operations runbook

All actions below are in the platform console (`/platform`, platform operators only) or the matching `/api/v1/platform/commercial/*` routes. Every write needs a reason and lands in the commercial audit log.

**Grant operator access:**
```
MIGRATION_DATABASE_URL=… npx tsx apps/api/src/database/promote-platform-admin-cli.ts <email>
```

## Set real prices
1. Plans → **New version** on the plan.
2. Edit the JSON terms: `currency`, `priceAmount`, `billingInterval`, `trialDays`, `features`, `quotas`, `settings`.
3. Give a reason.

The previous version ends when the new one takes effect. Existing subscriptions keep their version until a plan change or assignment. Check prices against your signed price list; the software ships with none.

## Provision a government or enterprise customer (no payment details)
1. The customer creates the organization (it starts on a trial), or you ask them to.
2. Organizations → Manage → **Contract**:
   - reference, PO, plan, term, billing frequency, payment terms, value, contact;
   - activation `pending_activation` until the PO is confirmed, or `active`.
3. Organizations → Manage → **Invoices**:
   - create the draft;
   - **Issue** it, which assigns the number and the due date;
   - send it through your normal channel. It is not a Faktur Pajak; issue the tax invoice separately through DJP systems.
4. When funds arrive: **Record payment** with amount, method, remittance reference (e.g. SP2D) and the date received. Partial payments are supported, and the same reference cannot be recorded twice.
5. Renewal: the scheduler sets `pending_renewal` 30 days before the contract end. Record the new contract (or extend `endDate`) and apply **renew**, or assign the plan again.

## Recover a past-due or suspended subscription
- **Contract or manual billing:** record the payment. When no invoice is overdue, the subscription returns to `active` automatically.
- **Exceptional extension:** lifecycle action `reinstate` (from suspended) or `payment_recovered`, with a reason.
- **Self-service** (once a provider exists): the provider's paid-invoice event restores it.
- **Data:** suspension never deletes data. The customer can read and export throughout.

## Temporary quota relief
Quota overrides: metric, limit (empty = unlimited), hard or soft, optional expiry, reason. A new override replaces the active one for that metric; revoke it to fall back to the plan.

## Usage disputes and corrections
1. `GET /platform/commercial/tenants/:id/usage/ledger?metric=…` lists the entries.
2. `POST …/usage/corrections {recordId, quantity (negative to reduce), reason}` adds a correction row; the original is never edited.
3. If aggregates look wrong, `POST …/usage/reconcile {reason}`.

## Billing health checks (daily)
Billing health shows:
- the provider status;
- subscriptions by status, trials ending within 7 days;
- invoices by status;
- webhooks in the last 7 days, failed or rejected webhooks (no payloads are stored for rejected ones);
- usage notice email status, open sales requests.

Failed webhook events are retried when the provider redelivers them. A rising rejected count means a wrong secret or forged traffic.

## Costs and margin
Costs & margin shows, for a date range:
- AI tokens, with estimated cost from operator-set prices (`/platform/ai/pricing`, each with a source) and the price update date;
- social provider units;
- **actual** provider costs that you enter from provider invoices (Record an actual provider cost);
- billed amounts and revenue (payments received).

A margin is shown only when revenue and cost are in one currency. Estimates are never presented as charges. Update AI prices whenever the provider's published prices change, and record the source.

## Test adapter (development only)
```
BILLING_PROVIDER=test BILLING_TEST_WEBHOOK_SECRET=<24+ random chars>
```
1. Start a checkout in the billing page.
2. Run `node scripts/billing-test-event.mjs checkout.completed --session <session id from the URL>`.

The API refuses this configuration in production.
