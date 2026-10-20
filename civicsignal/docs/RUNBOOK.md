# Operations runbook

Covers the worker (collection, analysis, issue detection, notifications) and the most likely incidents. Commands assume the
repository root; `$OWNER` is the migration/owner connection string.

## Processes
| Process | Command | Notes |
|---|---|---|
| API | `node apps/api/dist/main.js` | Stateless; scale horizontally |
| Worker | `node apps/api/dist/worker.js` | Runs ingestion, analysis, alert and report consumers, plus the schedulers (collection, alerts, analytics aggregation, reports). Flags: `--no-scheduler`, `--no-consumer`, `--no-analysis`, `--no-alerts`, `--no-reports` |
| Web | `next start` | |

- **One scheduler is enough.** Run more than one and the per-bucket job ids and `SKIP LOCKED` scheduling prevent duplicates.
- **Shutdown:** on SIGTERM the worker finishes its in-flight jobs and then exits.

## Queues (Redis, prefix `cs`)
| Queue | Jobs | Dead letters |
|---|---|---|
| `ingestion` | collection runs | `ingestion-dlq` |
| `analysis` | record analysis, summaries | failed analyses are recorded in `mention_analyses` |
| `alerts` | `evaluate` (per tenant per 5-minute bucket), `deliver`, `webhook`, `issue_summary` | `alerts-dlq` |
| `reports` | `generate` (one per run attempt) | failures are recorded on the run (`report_runs.status = failed`) |

Platform admins can monitor all of this without seeing tenant content:
- `GET /api/v1/platform/alerts`: depth, `lagSeconds` (age of the oldest waiting job) and dead letters, for the alerts,
  ingestion and analysis queues.
- `GET /api/v1/platform/ingestion`: worker heartbeats.
- `GET /api/v1/platform/reports`: report queue depth/lag, run status counts (24 h), oldest queued run, median duration,
  schedules failing 3+ times in a row, stored artifact volume, oldest/newest analytics refresh.

Alert on `lagSeconds > 600` for `alerts`, or a growing `alerts-dlq`.

Structured logs (JSON, one per line) include `alerts.evaluated`, `alerts.delivery_failed`, `alerts.webhook_failed`,
`alerts.scheduler_error`, `alerts.worker_error`, `alerts.summary_provider_failed` and `analysis.fallback_used`.

## Is detection running?
1. In the UI: Issues & alerts → "Last evaluation" tile. Or, per tenant, in SQL as owner:
   `SELECT status, rules_evaluated, issues_created, suppressed, finished_at FROM alert_evaluations WHERE tenant_id = '…' ORDER BY started_at DESC LIMIT 5;`
2. `suppressed` explains why rules did not alert: `insufficient_baseline`, `classification_uncertain`, `insufficient_sample`,
   `below_minimum_count`, `below_severity_minimum` or `current_window_not_covered`. A new deployment has no baseline for
   about `minBaselineWindows` days; volume and topic rules stay quiet until then. That is by design.
3. If evaluations are missing: check that the worker is up (heartbeat), that `REDIS_URL` is set, and the `alerts` queue lag.
   Trigger a run manually with `POST /organizations/:org/alert-rules/evaluate` (rate-limited).
4. Collection gaps reduce detection: check Issues & alerts → Collection freshness and Sources health.

## Notifications not arriving
1. Administration → Alert notifications shows the configured channels and recent deliveries with their status and error.
2. Statuses and what to do:

   | Status | Meaning | Action |
   |---|---|---|
   | `unconfigured` | Channel settings are missing | Set `SMTP_URL` / `EMAIL_FROM`, or the WhatsApp variables (see NOTIFICATIONS.md) |
   | `deferred` | Quiet hours | Sent automatically when they end |
   | `suppressed` | Daily quota reached, or no opted-in WhatsApp number | Raise `ALERTS_NOTIFICATIONS_PER_DAY`, or ask the user to opt in |
   | `failed` | A permanent rejection (e.g. SMTP 550), or a retry in progress | Fix the cause, then use "Retry" in the delivery log |
   | `dead` | All attempts used | Fix the cause, then use "Retry" in the delivery log |

3. **Self-healing:** deliveries stuck in `pending` (for example after a worker crash) are re-queued by the scheduler within
   about a minute.
4. **SMTP outage:** deliveries retry with backoff and then go `dead`. Once the provider is back, retry them from the log, or
   in SQL as owner:
   `UPDATE notification_deliveries SET status='pending' WHERE status='dead' AND created_at > now()-interval '1 day';`
   The scheduler then re-queues them.

## Webhook endpoint failing
- **After 20 consecutive dead deliveries** the endpoint is disabled automatically. Fix the receiver, re-verify it
  (`POST /webhooks/:id/verify`), and enable it again.
- **Rotating a leaked signing secret:** `POST /webhooks/:id/rotate-secret {"graceHours":0}` invalidates the old secret
  immediately.

## A rule is too noisy
- **Disable it** in Alert rules (PATCH `isActive:false`). Its open issues remain.
- **Tune it:** raise `minMentions`, `relativeChange` or `severity.minimum`, or lengthen `cooldownMinutes`. Use "Dry run" to
  see the effect on current data before saving. Every save creates a new version.

## Report scheduling
How it works: every minute the worker scheduler takes due schedules (`FOR UPDATE SKIP LOCKED`) and creates **one run per
(schedule, period)**. The idempotency key is `scheduleId:periodStart`, so repeated ticks, restarts or two schedulers never
duplicate a report. The period is the previous complete daily, weekly (Mon–Sun), monthly or N-day period **in the
schedule's time zone**, derived from the scheduled time, not from the time the tick happened. A late tick reports the same
period. Missed occurrences during an outage are not back-filled; the next run is computed from now. Use manual generation
with a custom period to fill gaps.

Delivery: in-app to each recipient, and email if enabled. Emails contain only the report name, period and a link that requires
sign-in, never the file or figures. Recipients are re-validated at delivery: they must be active members whose role has
`reports:read` and who can access the project. Others are recorded as `suppressed`. Without SMTP, email deliveries are
recorded as `unconfigured`, never as sent.

| Symptom | Check | Action |
|---|---|---|
| Report stuck in *Queued* | `GET /platform/reports` → queue lag; worker heartbeat | Start the worker (`REDIS_URL` set). Queued runs without a live job are re-queued automatically after 2 minutes; runs still queued after `REPORT_QUEUED_TIMEOUT_MINUTES` (120) are cancelled with that reason |
| Report stuck in *Generating* | `heartbeat_at` on the run | The sweep fails runs whose heartbeat is older than `REPORT_STALE_RUN_MINUTES` (15) as "Abandoned"; the requester and definition owner get a failure notice. Generate again |
| Run *Failed: Metric consistency check failed* | The error lists the mismatching totals | Usually data changing mid-run or a damaged aggregate: wait for the next aggregation refresh (2 min) and generate again. If it repeats, rebuild aggregates (below) and report the defect |
| Run *Failed: Reference validation failed* | A cited record left the project (query edit, deletion) during generation | Generate again |
| Run *Failed: Daily report quota reached* | `REPORT_RUNS_PER_DAY` | Raise the limit or wait 24 h |
| Schedule shows "n failed in a row" | Run errors in the history | Fix the cause; the counter resets on the next success |
| Email not received | Run detail → "my deliveries"; `report_deliveries.status/error` | `unconfigured`: set `SMTP_URL`/`EMAIL_FROM`. `suppressed`: the recipient lost project access or report permission. `failed`: SMTP error shown |
| Download returns 410 | `report_artifacts.expires_at` | Files expire after `REPORT_ARTIFACT_TTL_DAYS` (30); generate again |

Editing a schedule recomputes `next_run_at`. Cancelling is final (create a new schedule to resume); pausing (`isActive:false`) is reversible.
Deleting a report definition cancels its schedules; generated reports stay in the history until their files expire.

Structured logs: `reports.scheduler`, `reports.scheduler_error`, `reports.run_failed`, `reports.ai_commentary_failed`,
`reports.ai_quota_reached`, `reports.worker_error`, `analytics.refresh_failed`, `analytics.scheduler_error`.

## Analytics aggregates
`analytics_hourly` is refreshed incrementally every `ANALYTICS_REFRESH_INTERVAL_MS` (2 min) and fully once a day per tenant.
To force a full rebuild for a tenant (as owner): `UPDATE analytics_state SET full_rebuild_at = NULL WHERE tenant_id = '…';`
The next refresh rebuilds every hour and bumps the data version, which invalidates cached analytics. Dashboard timelines fall
back to base tables automatically whenever the aggregate is behind or does not add up, so a stale aggregate never shows wrong numbers.

## Rebuilding alert aggregates
`activity_hourly` and `topic_activity_daily` are recomputed for the last `ALERTS_REFRESH_HOURS` (48) at each evaluation.
To rebuild a longer history (for example after a backfill), raise `ALERTS_REFRESH_HOURS` temporarily and restart the worker.
The delete-and-insert is per tenant and idempotent.

## Rotating `CREDENTIALS_KEY`
Webhook signing secrets and connector credentials are encrypted with this key. After rotation, existing ciphertexts cannot
be decrypted: webhook deliveries are then skipped with an error, and connectors report credentials as unusable. Plan
rotation as follows:
1. Record which webhooks and credentials exist.
2. Rotate the key.
3. Rotate each webhook secret and re-enter each connector credential.
4. Give receivers the new webhook secrets.

## Database
- **Migrations:** `npm run migrate`. They are checksummed and refuse to run if an applied file was edited. 0008 refuses to
  replace the old placeholder alert tables if they hold data.
- **Backup and restore:** `scripts/backup.sh`, `scripts/restore.sh`; see SECURITY.md.
