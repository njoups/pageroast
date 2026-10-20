# Usage metering

The ledger is `usage_records`, extended in migration 0013. The aggregates are `usage_period_totals` and `usage_daily`. The code is in `apps/api/src/commercial/quota.ts`.

## Ledger rules
- **Idempotency.** `UNIQUE (tenant_id, metric, idempotency_key)`. Every writer uses a stable key, so retries, redelivered jobs and webhook replays count once:

  | Writer | Key |
  |---|---|
  | Ingestion | `connector_run:<run id>` |
  | Analyses | `analysis:<analysis id>` |
  | Tokens | `ai_usage:<ai_usage_records id>` |
  | Reports | `report_run:<run id>` |
  | Social units | `connector_run:<run id>` for syncs; a random id for refresh calls, each of which is real provider spend |
  | Downloads | per request |

- **Append-only.** The application role has no UPDATE or DELETE on `usage_records`. A correction is a new row (`kind = 'correction'`, possibly negative) with `corrects_id`, `reason` and `recorded_by`. A correction cannot take the corrected entry below zero.
- **Attribution.** Each row carries:
  - the tenant, and the project where known;
  - the subscription;
  - `usage_period_start`, plus `period_start`, the tenant-local day;
  - `occurred_at`;
  - `source` (ingestion, llm, baseline, reports, provider name, …);
  - `measurement`: `confirmed` for provider-reported or counted quantities, `estimated` reserved for estimates.
- **Late events** are attributed to the usage period of `occurred_at`, not to the arrival time.
- **Legacy rows** written before 0013 keep `source = 'legacy'` and key `legacy:<id>`. They belong to no usage period.
- **Operational counters** (`connector_requests`, `records_collected`, `rate_limit_responses`) stay in the ledger for operations. They are not plan quotas.

## Usage periods
- Monthly windows anchored at the subscription's `usage_anchor`: the local day and time in the tenant's time zone (`tenants.settings.timezone`, default Asia/Jakarta).
- Anchors on the 29th–31st clamp to shorter months. Periods are contiguous, and daylight-saving changes are handled.
- Annual and contract subscriptions also reset usage monthly.
- Daily aggregates use the tenant-local day.

## Metrics

| Metric | Kind | Measured as | Enforcement point |
|---|---|---|---|
| seats | gauge | members + open invitations | invitation create (hard lock); accept needs an active subscription |
| projects | gauge | non-archived projects | create and unarchive |
| monitoring_queries | gauge | active queries | create and activate |
| active_connectors | gauge | enabled sources | enable (social also needs `social_listening`) |
| report_schedules | gauge | active schedules | create and activate (`scheduled_reports`) |
| alert_rules | gauge | active rules | create and activate |
| notification_channels | gauge | webhook endpoints | create (`webhooks`) |
| storage_mb | gauge | approximate mention text + report files | shown only; soft by design |
| mentions_ingested | counter | new records stored per run | the collection gate stops **new** runs at a hard limit; a permitted run stores everything it fetched, recorded as overage |
| ai_analyses | counter | completed analyses | checked when an analysis starts: `quota_exceeded`, with the mention kept for reprocessing |
| ai_tokens | counter | provider-reported input + output tokens | when reached: analyses fall back to the baseline; LLM summaries and commentary are skipped |
| reports_generated | counter | report runs | atomic with run creation (manual: 402; scheduled: run failed with the reason) |
| exports | counter | report downloads | per download (seeded plans: soft) |
| social_api_units | counter | provider quota units | recorded after spend; the collection gate pauses social syncs at a hard limit |
| api_requests | counter | reserved | no public API |

## Concurrency
- **Counters.** The period-total row is created if missing, then locked `FOR UPDATE`. The hard-limit decision, the ledger insert and the aggregate update all happen in that transaction. With `enforce`, nothing is written when the limit would be exceeded.
- **Gauges.** `pg_advisory_xact_lock(hashtext('quota:<tenant>:<metric>'))` is held for the rest of the transaction, so the count and the insert are serialised.
- **Tests** (`test/integration/commercial.e2e.ts`): 8 parallel project creations against a limit of 3 give exactly 3 successes; 25 parallel consumptions against a limit of 10 give exactly 10, and ledger = period total = daily total.

## Thresholds
- `usage_notices` holds one row per tenant, metric, usage period and threshold (unique). Thresholds default to 70/85/95/100 and are set by `notice_thresholds`.
- Notices are created in the consuming transaction, shown in the billing page and emailed once by the scheduler.

## What is never blocked
Audit logging, retention runs, deletion requests, legal hold, the social refresh-or-delete lifecycle, session and password security, reading data and exports do not call the quota service (`NEVER_BLOCKED` in `catalog.ts`). A quota never deletes collected records.

## Reconciliation
`POST /platform/commercial/tenants/:id/usage/reconcile` (reason required) recomputes period and daily aggregates from the ledger and reports how many rows it fixed. `GET …/usage/ledger` lists entries.
