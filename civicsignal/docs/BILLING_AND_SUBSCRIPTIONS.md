# Billing and subscriptions

Implemented in Prompt 08. The code is in `apps/api/src/commercial/` and the schema in `db/migrations/0013_commercial.sql`.
**No live payment provider is integrated.** See section 6.

## 1. Plans and versions
- `plans` holds the identity of a plan: code, name, category (`trial`, `self_service`, `sales_assisted`, `public_sector`, `internal`), whether it is shown to customers (`is_public`) and whether it can be assigned (`is_active`).
- `plan_versions` holds the terms: currency, `price_amount` (NUMERIC(14,2); **NULL means price on request**), interval (`month` / `year` / `custom`), `trial_days`, `features`, `quotas` and `settings`, plus `effective_from` and `effective_to`.
- **Versions are immutable.** The application role may change only `effective_to`, so a new version closes the previous one. Subscriptions and invoices point to a version, so a later change never rewrites what a customer bought.
- **Seeded plans** are trial, pilot, starter, professional, agency, enterprise and government. None has a price. Their quotas are starting values for evaluation, not commercial commitments. Operators add a version with real prices in the platform console (Plans → New version) or through `POST /platform/commercial/plans/:code/versions`.

### Features (on/off, independent of quotas)
`ai_analysis`, `social_listening`, `scheduled_reports`, `executive_analytics`, `webhooks`, `whatsapp`, `white_label_reports` and `api_access`.

| Feature | What it gates |
|---|---|
| `ai_analysis` | Without it, analyses run on the rule-based baseline. Analyses never stop because of this feature. |
| `social_listening` | Creating, enabling and collecting social connectors |
| `scheduled_reports` | Creating and activating schedules; a scheduled run without it fails with the reason |
| `executive_analytics` | The `monthly_performance` and `policy_monitoring` report templates |
| `webhooks` | Webhook endpoints |
| `whatsapp` | WhatsApp deliveries are suppressed with a reason |
| `white_label_reports` | Custom brand colour on reports; otherwise the default palette |
| `api_access` | Always off. No public API exists. |

### Quotas
Each quota is `metric → {limit, enforcement: hard|soft|none, overage}`. A `limit` of null means unlimited. A metric not listed in the plan is unlimited, except `api_requests`. Metric definitions are in [USAGE_METERING.md](USAGE_METERING.md).

### Settings
| Setting | Meaning |
|---|---|
| `notice_thresholds` | Usage notice thresholds; default 70/85/95/100 |
| `past_due_grace_days` | Days a subscription stays usable while past due |
| `max_retention_days`, `audit_retention_days` | Retention limits (informational; see the limitations) |
| `support_level` | Support level (informational; see the limitations) |

### Overrides
Per-tenant `quota_overrides` can be set by platform operators only. They need a reason (at least 5 characters), may expire, and are revoked rather than deleted.

## 2. Subscription states (`commercial/lifecycle.ts`)
Each organization has one current subscription (unique where `ended_at IS NULL`). Every status change goes through `transition()`, which checks the transition table, updates the row and appends a `subscription_events` row in the same transaction.

| Event | From → to |
|---|---|
| activate | trialing / pending_activation / pending_renewal → active |
| request_activation | trialing → pending_activation |
| payment_failed | active / pending_renewal → past_due |
| payment_recovered | past_due / suspended → active |
| suspend | any non-terminal → suspended |
| reinstate | suspended → active |
| renewal_due | active → pending_renewal |
| renew | active / pending_renewal / past_due → active |
| trial_expired | trialing → expired |
| cancel_now | any non-terminal → canceled |
| period_end_cancel | active / pending_renewal / past_due / trialing → canceled |
| term_expired | pending_renewal / suspended / past_due → expired |

`canceled` and `expired` are terminal. They set `ended_at`; a new plan assignment creates a new subscription row.

### Access per state
| Access | States | Meaning |
|---|---|---|
| Full | trialing, active, pending_renewal, past_due (grace) | Everything the plan includes |
| Limited | pending_activation | Setup only (projects, members, sources); no collection, AI or reports |
| Read-only | suspended, canceled, expired, no subscription | Data, exports, audit, governance, deletion and retention all keep working. Nothing is deleted. |

Customers cannot set states. The tenant API offers only cancel-at-period-end and resume (self-service or trial), checkout and sales requests. All other changes come from operators (with a reason), verified provider webhooks, or the scheduler.

### Scheduler (`commercial/scheduler.ts`, worker every 5 minutes, idempotent)
1. Overdue invoices; for contract or manual billing, `payment_failed`.
2. Trial expiry, or cancel if cancellation was requested.
3. Past-due grace elapsed → `suspend` (reason `past_due_grace_elapsed`).
4. Scheduled plan changes.
5. Period end: cancel-at-period-end, or roll manual and contract periods forward. Self-service periods move only on a paid provider invoice.
6. Contract renewal due 30 days before the end date; `term_expired` after the end date plus the grace days.
7. Usage notice emails to owners and admins, once each. Without SMTP they are marked `not_configured`.

## 3. Trials and new organizations
`POST /organizations` starts the `COMMERCIAL_TRIAL_PLAN` (default `trial`, 14 days) inside the same transaction. No payment details are asked for. Organizations that existed before migration 0013 were moved to `pilot` (unlimited, manual billing) and recorded as `migrated`.

## 4. Contract and government procurement
Operators record a contract (`POST /platform/commercial/tenants/:id/contracts`) with these fields:
- contract reference and PO reference;
- plan, start and end dates;
- billing frequency and payment terms;
- value and currency, renewal date;
- contact, document references and notes.

Activation can be `none` (draft), `pending_activation` or `active`; the last two assign the plan with `billing_mode = 'contract'`. Contract customers never see checkout and cannot cancel themselves. Their billing page shows the contract details and invoices.

## 5. Invoices and payments (`commercial/invoices.ts`)
- **Statuses:** draft → issued → partially_paid / paid. The scheduler moves issued invoices to overdue. Drafts can be canceled; issued or overdue invoices without payments can be voided. All other transitions are refused (409).
- **Numbers:** assigned only when an invoice is issued, as `INVOICE_NUMBER_PREFIX-YYYY-NNNNNN` from a sequence. Numbers are never reused; gaps are possible.
- **Amounts** are NUMERIC(16,2). The database checks `total = subtotal + tax` and `amount_paid ≤ total`.
- **Idempotency:** an optional key makes invoice creation idempotent per tenant.
- **Manual reconciliation:** each payment records amount, method (bank transfer, government treasury, other), remittance reference (e.g. an SP2D number) and the date received.
  - The same reference cannot be recorded twice on one invoice.
  - Overpayment is refused.
  - A fully paid invoice restores a past-due subscription, or one suspended for non-payment.
- **Visibility:** customers see issued invoices only. Drafts are internal.
- **Not a Faktur Pajak.** Every invoice response and page carries this notice. Tax data (`tax_metadata`, buyer tax ID) is stored for reference only; no e-Faktur or Coretax integration exists.

## 6. Payment provider boundary (`commercial/billing-provider.ts`)
The `BillingProvider` interface covers:
- `createCheckout`, `cancelSubscription`, `resumeSubscription`;
- `createPortalSession`, `refund`;
- `verifyWebhook`, which returns normalised events: `checkout.completed`, `invoice.paid`, `invoice.payment_failed`, `subscription.canceled`, `refund.created`.

| `BILLING_PROVIDER` | Behaviour |
|---|---|
| `none` (default) | Checkout and portal answer 503 `billing_provider_not_configured`. Webhook endpoint returns 404. The UI says online payment is not configured. |
| `test` | Local simulator, **refused when NODE_ENV=production**. Moves no money. Requires `BILLING_TEST_WEBHOOK_SECRET` (at least 24 characters). Uses its own documented event format, not any real provider's. `scripts/billing-test-event.mjs` sends signed events. |

### Webhooks: `POST /api/v1/billing/webhooks/:provider`
- No session; verified by signature only. Rate-limited per IP; raw body kept for verification.
- The test adapter's signature header is `x-civicsignal-test-signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`. Timestamps are accepted within ±300 s, and the comparison is constant-time.
- Unverified requests are rejected (400) and logged in `billing_webhook_events` with `status = 'rejected'`, **without the payload**.
- Event ids are unique per provider:
  - a replayed processed event returns `duplicate` and has no effect;
  - a failed event can be redelivered and is processed again.
- The plan changes **only** on a verified `checkout.completed` for a session this tenant started (recorded as a `checkout_started` event). The return page shows "waiting for confirmation" and nothing more.

### Adding a real provider (not done)
1. Choose the provider (e.g. Xendit or Midtrans for Indonesian payment methods, or Stripe) and open an account.
2. Implement the interface from the provider's official documentation: its signature scheme, event names and idempotency.
3. Add the adapter to `createBillingProvider` and to the config validation.
4. Keep keys in server environment variables only.
5. Register the webhook URL with the provider.
6. Test against the provider's sandbox before switching `live`.

Do not reuse the test adapter's event format.

## 7. API summary
**Tenant routes** (`organizations/:orgId/…`):

| Route | Permission |
|---|---|
| `GET entitlements` | `org:read` |
| `GET billing`, `billing/plans`, `billing/usage/history`, `billing/usage/daily`, `billing/invoices[/:id]`, `billing/events`, `billing/sales-requests` | `billing:read` (owner, admin) |
| `POST billing/sales-requests`, `billing/notices/:id/acknowledge` | `billing:read` |
| `POST billing/checkout`, `billing/cancel`, `billing/resume`, `billing/portal` | `billing:manage` (owner) |
| `GET onboarding` | `org:read` |
| `PUT onboarding/steps/:step` | `org:update` |

**Platform routes** (`platform/commercial/…`, session plus `is_platform_admin`; tenant roles never grant access):
- plans and versions; tenants, subscription assign / transition / change-plan / cancel-at-period-end;
- overrides; usage ledger, corrections and reconcile; contracts;
- invoices: draft, issue, payments, void; costs and cost entries;
- health, audit, sales requests.

Every write needs `reason` and is audited as `commercial.*` in the tenant's audit log, or as a platform event for plans and costs.

## 8. Limitations
- No live payment provider; no automated dunning emails beyond usage notices.
- No proration on upgrades. A plan change applies at once, or is scheduled for the period end.
- Invoices are not tax invoices.
- `max_retention_days`, `audit_retention_days` and `support_level` are informational: retention is governed by the tenant's data-governance settings (`DATA_GOVERNANCE.md`) and is not automatically capped by the plan.
- `api_access` and `api_requests` are reserved; there is no public API.
