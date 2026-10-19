# Operations runbook

Covers the worker (collection, analysis, issue detection, notifications) and the most likely incidents. Commands assume the
repository root; `$OWNER` is the migration/owner connection string.

## Processes
| Process | Command | Notes |
|---|---|---|
| API | `node apps/api/dist/main.js` | Stateless; scale horizontally |
| Worker | `node apps/api/dist/worker.js` | Runs ingestion, analysis and alert consumers, plus the schedulers. Flags: `--no-scheduler`, `--no-consumer`, `--no-analysis`, `--no-alerts` |
| Web | `next start` | |

- **One scheduler is enough.** Run more than one and the per-bucket job ids and `SKIP LOCKED` scheduling prevent duplicates.
- **Shutdown:** on SIGTERM the worker finishes its in-flight jobs and then exits.

## Queues (Redis, prefix `cs`)
| Queue | Jobs | Dead letters |
|---|---|---|
| `ingestion` | collection runs | `ingestion-dlq` |
| `analysis` | record analysis, summaries | failed analyses are recorded in `mention_analyses` |
| `alerts` | `evaluate` (per tenant per 5-minute bucket), `deliver`, `webhook`, `issue_summary` | `alerts-dlq` |

Platform admins can monitor all of this without seeing tenant content:
- `GET /api/v1/platform/alerts`: depth, `lagSeconds` (age of the oldest waiting job) and dead letters, for the alerts,
  ingestion and analysis queues.
- `GET /api/v1/platform/ingestion`: worker heartbeats.

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

## Rebuilding aggregates
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
