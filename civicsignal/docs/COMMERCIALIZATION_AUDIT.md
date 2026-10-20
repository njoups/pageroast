# Commercialization audit

**Date:** 2026-10-20. **Method:** read the docs, then verified each item in code, migrations and the dev database. Documented intentions were not taken as implemented.

## 1. What existed before this milestone (verified)

| Item | Where | State |
|---|---|---|
| `subscriptions` table (`plan_code`, `status` trialing/active/past_due/canceled, `limits` jsonb, `feature_flags` jsonb, `billing_provider`, `billing_reference`, period dates) | `0002_domain_schema.sql`, RLS in 0003 | **Schema only.** No code reads or writes it. 0 rows in the dev database. |
| `usage_records` (tenant, metric, quantity, `period_start` date, metadata) | 0002; written by `ingestion/pipeline.service.ts` (`connector_requests`, `records_collected`, `rate_limit_responses`) and `analysis/analysis.service.ts` (`ai_analyses`) | **Written but not auditable:** no idempotency key, so a retried job or redelivered message counts twice. No source, no estimated/confirmed flag, no corrections. `period_start` is the UTC `current_date`, not a billing period. Not read anywhere. |
| AI quotas | `ai_tenant_settings` (`daily_mention_limit`, `monthly_token_limit`, `auto_analyze`); `analysis/usage.ts` `quotaState`; checked in `analysis.service.ts` and summaries | **Works**, as an operational safety limit configured per tenant by its own admins. Not tied to a plan. |
| AI cost accounting | `ai_usage_records` (tokens in, out and cache from the provider response; `cost_estimate` from `ai_pricing`) and `ai_pricing` (platform-managed, with source) | **Works.** Token counts are provider-reported; cost is an estimate. Append-only. |
| Social provider usage | `provider_usage`, `provider_pricing`, `social_budgets` (0012) | **Works** per connector and provider day |
| Report limits | `REPORT_RUNS_PER_DAY`, `REPORT_CONCURRENT_RUNS` | Global environment settings, the same for every tenant |
| Billing permissions | `billing:read` (owner, admin), `billing:manage` (owner) in `authz/permissions.ts` | Declared, **no routes use them** |
| Platform admin | `users.is_platform_admin`, `PlatformAdminGuard`, `/platform` routes (queue/AI/report health, AI pricing CRUD, tenant metadata list) | **Works, API only.** No platform UI. Admin actions on AI pricing are audited. |
| Payment provider | — | **None.** No SDK, credentials, webhook route or environment variables (`grep -ri "stripe\|xendit\|midtrans\|paddle"` finds nothing). |
| Invoices, contracts, plans, entitlements | — | **None** |
| Onboarding | `apps/web/src/app/onboarding/page.tsx`: create an organization or accept an invitation | **Minimal.** Nothing is persisted after the organization is created. |
| Billing UI | `nav.ts` lists "Billing" as unavailable ("Milestone 6") | **None** |
| Public API access (API keys) | — | **None.** The API serves only the session-cookie web app. |
| White-label reports | Report definitions accept a brand colour (`params`) | Partial: colour only, no logo |

## 2. Gaps and risks
1. **No subscription is enforced anywhere.** Every tenant can use everything without limit, apart from the AI safety limits and global report limits.
2. **Usage counts cannot be used for billing:** they double-count retries and are not tied to periods or sources.
3. **Unlimited resource creation:** no server-side limits on users, projects, queries, connectors, alert rules or schedules.
4. **Race conditions:** any limit added naively would be raced by concurrent jobs, because nothing reserves or locks.
5. **No provider:** checkout or payment success must not be shown.
6. **No procurement path** for Indonesian government customers, who buy by contract, purchase order and manual invoice, not by card.
7. **No platform-level commercial administration:** no plan management, overrides, invoices, webhooks or cost view.
8. **Legal:** generated invoices are **not** Faktur Pajak (e-Faktur/Coretax). Indonesian tax-invoice requirements must not be claimed.

## 3. Decisions taken in this milestone
| Decision | Reason |
|---|---|
| **Extend** `subscriptions` and `usage_records`; do not create parallel tables | Avoid duplicate entities. Existing rows are kept, and legacy usage rows are marked `source = 'legacy'`. |
| New: `plans` + immutable `plan_versions` (prices, entitlements, quotas, effective dates) | Plan changes never rewrite history. Subscriptions point to a version. |
| Quotas live in plan versions, plus audited per-tenant overrides with a reason and expiry | Configurable, no hardcoded numbers in code |
| Seeded plans have **no prices** (null = "contact sales") | No commercial prices are invented. Operators set them. |
| Existing tenants are migrated to a `pilot` plan with no limits, `billing_mode = 'manual'` | Preserves current behaviour; the operator assigns a real plan |
| New organizations start a trial on the configured trial plan (`COMMERCIAL_TRIAL_PLAN`) | Self-service start without a payment method |
| `ai_tenant_settings` stays | It is the tenant's own operational cap. The plan quota is an additional, commercial cap. Both are checked; the stricter wins. |
| Billing provider adapter: `none` (default) and `test` (development only, refused in production). **No real provider adapter** | No provider is configured and no credentials exist. A fake integration is worse than none. |
| Contract and manual invoicing are first-class | Government procurement |
| Quota consumption is atomic: ledger insert (idempotent) + per-period total row locked `FOR UPDATE` in the same transaction. Resource counts take a per-tenant advisory lock | Concurrent jobs cannot overshoot hard limits |
| Commercial quotas never block security, audit, retention, deletion or lifecycle work, and never delete collected data | Requirement; data-governance duties outrank billing |

## 4. Out of scope or blocked
- **Live payments:** they need a provider choice (for example Xendit or Midtrans for Indonesian methods, or Stripe), an account, keys and webhook configuration. See BILLING_AND_SUBSCRIPTIONS.md.
- **Faktur Pajak / e-Faktur:** needs a tax consultant and integration with the DJP system.
- **Public API keys:** an `api_access` entitlement is defined but no API-key feature exists, so it is shown as "not available".
- **White-label logos:** `white_label_reports` gates the existing brand colour only.
