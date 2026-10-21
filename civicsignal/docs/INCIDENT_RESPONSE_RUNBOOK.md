# Incident Response Runbook

> This is a starting procedure for the operator. It does not replace the customer's or agency's own incident and
> breach-notification obligations. Under Indonesian law, notification duties may apply (for example UU No. 27/2022
> Pelindungan Data Pribadi, sector and agency rules). Their scope, deadlines and recipients must be confirmed with qualified
> Indonesian legal counsel before go-live. Nothing here asserts compliance with any law or standard.
> **None of these procedures has been exercised on a staging or production environment** (none exists). Rehearse
> scenarios 1, 2, 5 and 6 on staging before the pilot.

This runbook replaces `INCIDENT_RESPONSE.md`.
Alert rules (`infra/monitoring/alerts.yml`) link to the numbered sections below.
Related runbooks:
- [DISASTER_RECOVERY_RUNBOOK.md](DISASTER_RECOVERY_RUNBOOK.md): restores;
- [RUNBOOK.md](RUNBOOK.md): day-to-day operations;
- [COMMERCIAL_OPERATIONS_RUNBOOK.md](COMMERCIAL_OPERATIONS_RUNBOOK.md): billing.

## Ground rules
1. **Containment of data exposure and credential compromise comes first**, ahead of restoring convenience features.
2. **Never delete logs, audit events, database instances or backups during an incident.** Set legal holds and snapshot before changing data.
3. Every action goes into the incident record with a timestamp and the person who took it (not only in chat).
4. Emergency code changes still need one reviewer, green CI and the approved deploy workflow.
5. Communications state verified facts only. Never include secrets, other tenants' names or data, or speculation.

## Severity

| Level | Examples | Response |
|---|---|---|
| **SEV-1** | Confirmed or likely cross-tenant exposure; credential or key compromise; audit-chain verification failure; total outage; data loss or corruption | Page the on-call and incident commander now; work continuously; tenant communication within the agreed window |
| **SEV-2** | Partial outage (ingestion, alerts or reports stopped > 1 h); suspected but unconfirmed exposure; one tenant affected; billing state wrong | Respond within 1 h in business hours, 4 h otherwise |
| **SEV-3** | Degraded performance; one failed connector or report; security finding with no evidence of exploitation | Next business day |

## Roles
- **Incident commander (IC):** owns the incident, decides, keeps the timeline. Not the person typing fixes.
- **Operations lead:** containment and recovery.
- **Communications lead:** customer, management and regulator communications, approved by the IC and counsel.
- **Scribe:** the timestamped incident record.
- **Counsel / DPO:** notification duties and wording.

## Common tools
- **Logs:** JSON lines with `event`, `env` and `requestId`. Error responses carry `requestId`, so search by it.
- **Metrics and alerts:** `/metrics` (internal, token), Prometheus and Alertmanager (DEPLOYMENT.md § Observability).
- **Audit:** `audit_events` per tenant, hash-chained. Verify a chain with `SELECT * FROM audit_verify_chain('<tenant id>')` (owner connection, read-only). The platform console shows the commercial audit.
- **Legal hold** on a tenant: `PUT /api/v1/organizations/<id>/data-governance/controls {"legalHold": true}` (owner). It stops retention purges and deletion requests.
- **Freeze writes:** stop `worker`, then `api` (Compose `stop`, or scale to 0). The edge then serves an error page.
- **Session revocation:**
  - one user: `UPDATE sessions SET revoked_at = now() WHERE user_id = '<id>' AND revoked_at IS NULL`;
  - everyone: the same without the user filter (owner connection).

---

## 1. Application outage
- **Detection:** `CivicSignalApiDown`, `CivicSignalPublicReadinessFailing`, `CivicSignalHighErrorRate`, `CivicSignalSlowRequests`, customer reports. The deploy workflow's `/readyz` or smoke step failing.
- **Immediate containment:**
  - If it started right after a deployment, roll back to the previous digests now (DEPLOYMENT.md § Rollback).
  - If CPU is saturated by logins (credential stuffing), tighten the edge or WAF rate limit on `/api/v1/auth/*`.
- **Investigation:**
  1. Check `docker compose ps` or the platform's health view.
  2. Check `/health/ready` from inside the network: which of database, Redis or migrations is down?
  3. Read the container logs around the first error (`requestId`), and check memory against the limits (OOM kills show exit code 137).
  4. Check the TLS certificate and DNS if only the public check fails.
- **Recovery:** restart the failed service; roll back; scale out (DEPLOYMENT.md § Capacity). If the database is down, go to section 2.
- **Validation:** `/readyz` ok, `scripts/smoke.mjs` passes, error rate and p95 back to baseline for 30 minutes.
- **Audit records:** incident record with the timeline, deployed SHA and digests, and rollback actions. Deploy runs are kept in GitHub.
- **Escalation:** SEV-1 if fully down for more than 15 minutes or data integrity is in doubt. Call the hosting provider for infrastructure faults.
- **Customer communication:** acknowledge within the agreed window. Give an estimated next update, not an estimated fix time, until the cause is known. Scheduled reports and alerts missed during the outage are listed afterwards.

## 2. Database unavailable
- **Detection:** readiness shows `database: down`; `CivicSignalDbPoolSaturated`; `CivicSignalDiskFilling`; provider alarms; 5xx spike.
- **Immediate containment:**
  - Stop the worker so retries do not pile up.
  - Do **not** restart the database repeatedly, and do not delete files or WAL to free space.
- **Investigation:**
  1. Provider status and instance metrics (CPU, storage, connections).
  2. `pg_stat_activity` for blocking locks or long transactions; connections against `max_connections`.
  3. Disk usage (WAL, `report_artifacts`). Did a migration just take a lock?
- **Recovery:**
  - Free connections by stopping clients.
  - Grow storage (managed: increase disk).
  - Fail over (managed multi-AZ).
  - If the instance is lost or corrupt: DISASTER_RECOVERY_RUNBOOK.md § 5.2 (restore to new).
- **Validation:** readiness `database: up`, `migrations: current`, smoke test, queue lag draining.
- **Audit records:** incident record, provider ticket number, the chosen recovery point if restored.
- **Escalation:** SEV-1 beyond 15 minutes. Engage the provider's support. The recovery owner decides on a restore.
- **Customer communication:** service unavailable; whether any data written in the window is lost (only if a restore to an earlier point happens).

## 3. Queue backlog
- **Detection:** `CivicSignalQueueBacklog`, `CivicSignalIngestionOverdue`, `CivicSignalNoWorkers`, `civicsignal_queue_jobs{state="failed"}` growing.
- **Immediate containment:**
  - If the worker crash-loops, stop it and keep the API serving (read access still works).
  - If one tenant's backlog dominates, pause its sources or rules.
- **Investigation:**
  1. Worker logs (`ingestion.worker_crashed`, job errors), heartbeat count, Redis memory (`noeviction` errors).
  2. Is the AI provider rate-limiting (section 4)? Is a slow feed host spaced out?
  3. Use RUNBOOK.md § Queues to inspect the dead-letter queues.
- **Recovery:**
  - Restart the worker.
  - Add workers with `--no-scheduler` (never a second scheduler).
  - Retry dead-lettered jobs after fixing the cause.
- **Validation:** lag back under the alert threshold, overdue collections at 0, alerts and reports flowing (`report_runs_last_hour` succeeding).
- **Audit records:** incident record; retried job counts.
- **Escalation:** SEV-2 when alerts or reports have been late for more than 1 h. SEV-1 if notifications were lost (none expected: deliveries are database-backed).
- **Customer communication:** for delays over the pilot's alert-latency expectation, tell affected organizations which alerts or reports were delayed, and by how long.

## 4. Provider outage
Covers the AI provider, YouTube, publishers' feeds, the SMTP relay, WhatsApp and webhook receivers.
- **Detection:**
  - `CivicSignalAnalysisFailing`, `CivicSignalAiQuotaExhausted`, `CivicSignalSocialQuotaPaused`;
  - `CivicSignalIngestionFailing`, `CivicSignalNotificationsFailing`, `CivicSignalWebhooksFailing`, `CivicSignalEmailUnconfigured`;
  - provider status pages.
- **Immediate containment:**
  - **AI:** the default `AI_FALLBACK=baseline` keeps analysis running and labels results `partial`; check it is set. Do not raise rate limits to "catch up" while the provider is throttling.
  - **Social:** the budget and quota pause is automatic. Do not raise budgets to exceed provider quotas.
  - **Never** substitute fabricated or placeholder data for a missing provider.
- **Investigation:**
  - Error kinds in logs: rate limit, auth, timeout, 5xx.
  - Whether the failure follows a credential change (section 6).
  - The provider's status page and quota console.
- **Recovery:**
  - Wait for the provider, or fix credentials.
  - Re-run failed analyses (backfill) and retry dead deliveries once the provider is healthy, within quotas and budgets.
- **Validation:** failure gauges back to zero; a test notification to an internal address arrives; a collection run succeeds.
- **Audit records:** incident record; counts of records analysed with baseline fallback and of notifications delayed.
- **Escalation:** SEV-2 if alerts cannot be delivered for more than 1 h (customers rely on them). Contact the provider's support.
- **Customer communication:**
  - which outputs were affected (for example "analyses between 10:00 and 12:00 used the rule-based baseline");
  - delayed notifications;
  - any coverage gap in collected sources. Coverage gaps are never back-filled with substitute data.

## 5. Suspected tenant data exposure
- **Detection:** a customer report; `authz.denied` spikes; anomalies in the audit log; a security test or code review finding; data visible in the wrong organization.
- **Immediate containment (SEV-1 until disproven):**
  1. Preserve evidence: snapshot the database; export the relevant audit events and logs; record file hashes.
  2. Set a legal hold on the affected tenants.
  3. Identify the code path. Disable the feature behind it: block the route at the edge, disable the report schedule or webhook, or stop the worker if a job is involved. Do not hot-patch without review.
  4. If a person's account is involved, revoke their sessions.
- **Investigation:**
  1. Reproduce in staging with synthetic data, never with the customer's data.
  2. Determine the scope from access logs (`requestId`, user, tenant) and audit events: which records were exposed, to whom, and since when.
  3. Check the RLS policies and route guards involved; verify the audit chains.
- **Recovery:**
  - Fix through review and CI, with a regression test in the cross-tenant matrix.
  - Deploy through staging first.
  - Rotate any secrets that were exposed.
- **Validation:** the regression test passes, the cross-tenant matrix passes, the affected route is re-enabled, and the audit chains verify.
- **Audit records:** incident record; evidence hashes; the list of affected records and tenants (kept restricted); counsel's notification decision.
- **Escalation:** IC, counsel/DPO and management immediately. Counsel decides on regulator and data-subject notification within the legal deadlines.
- **Customer communication:** each affected organization separately, with only its own facts: what, when, which data, what was done, what they should do. Never name or describe other tenants.

## 6. Compromised credentials
Covers user accounts, `CREDENTIALS_KEY`, database or Redis passwords, the AI key, SMTP, deploy tokens, `METRICS_TOKEN` and webhook secrets.
- **Detection:** secret-scan finding in CI; provider usage anomaly; `auth.login_failed` bursts followed by success; unexpected platform-admin activity (section 11); a credential seen in logs or tickets.
- **Immediate containment:**
  - Rotate the exposed credential (DEPLOYMENT.md § Secrets rotation table), with the custodian's authorization.
  - **User account:** remove the membership or set `users.disabled_at`, revoke sessions, force a password reset.
  - **All sessions suspect:** revoke all sessions.
  - **`CREDENTIALS_KEY`:** rotate it (RUNBOOK.md § Rotating `CREDENTIALS_KEY`), then rotate every connector credential and webhook secret.
  - **Database passwords:** new `APP_DB_PASSWORD` through the migrate job, plus the owner password; restart api and worker.
  - **AI/SMTP/WhatsApp keys:** revoke at the provider, set the new key, restart.
  - **Committed secret:** rotate first; history rewriting is secondary (the value must be treated as public).
- **Investigation:**
  - The window of exposure.
  - What the credential allowed: database role privileges, provider scopes.
  - Provider usage logs, `pg_stat_activity` and connection logs, and the audit events for the window.
- **Recovery:** confirm the old credential is revoked (a test with it fails) and the services run on the new one.
- **Validation:** readiness and smoke pass; the provider usage anomaly has stopped; the secret scan is clean.
- **Audit records:** incident record; rotation entries in the change log (custodian, time, scope). The audit trail of revocations is kept.
- **Escalation:** SEV-1 for `CREDENTIALS_KEY`, database owner or deploy tokens. Counsel if personal data may have been accessed.
- **Customer communication:** required if customer data or their connector or webhook credentials could have been accessed. Tell them which credentials they must rotate on their side (webhook receivers, YouTube keys).

## 7. Unexpected billing behaviour
- **Detection:** `CivicSignalBillingWebhookFailures`; customer complaints (wrong plan, unexpected suspension, wrong invoice); the platform console's commercial health page; usage reconciliation differences (COMMERCIAL_OPERATIONS_RUNBOOK.md § daily checks).
- **Immediate containment:**
  - Do **not** delete subscriptions, invoices, payments or ledger rows: payments are append-only and issued invoices are immutable by design.
  - If a customer was suspended wrongly, reinstate them through the platform console (audited transition). Apply a temporary quota relief override if usage blocking is wrong.
- **Investigation:**
  - `subscription_events` and `billing_webhook_events` (status, error) for the tenant.
  - The usage ledger against its aggregates (reconcile).
  - Which code path or rule acted (scheduler tick, webhook, operator).
- **Recovery:**
  - Corrections through the platform console: usage corrections with an idempotency key, invoice void and re-issue, plan reassignment.
  - Code fixes through review and CI.
  - No live payment provider exists; with the `test` simulator only staging is affected.
- **Validation:** the tenant's billing page shows the correct plan, period and usage; reconcile reports no drift; webhook failures are at 0.
- **Audit records:** the commercial audit entries (automatic), with the incident reference in each operator action's reason.
- **Escalation:** SEV-2. Management if invoices already sent to a customer were wrong.
- **Customer communication:** explain the correction and issue corrected documents. Invoices are labelled "not a Faktur Pajak": tax documents are outside this system.

## 8. Failed backups
- **Detection:** `CivicSignalBackupStale` (page), `CivicSignalBackupMetricMissing`, managed-backup failure notifications, a failed restore drill.
- **Immediate containment:**
  - Take a manual backup now (DISASTER_RECOVERY_RUNBOOK.md § 4.2) and confirm it lands off-host.
  - Avoid risky changes (migrations, bulk operations) until a good backup exists.
- **Investigation:**
  - Backup job logs: authentication, disk space, `pg_dump` version, GPG key expiry, storage permissions.
  - Whether PITR is still healthy (provider console).
- **Recovery:** fix the cause, re-run the backup, then run the restore drill on the new backup.
- **Validation:** the metric timestamp is fresh; `verify-restore.sh` passes; the copy exists in off-host storage.
- **Audit records:** incident record; an entry in the DR verification record if a drill was run.
- **Escalation:** SEV-2 after 26 h without a backup; SEV-1 if PITR is also unavailable.
- **Customer communication:** usually none. Required if a restore became necessary and the agreed RPO could not be met.

## 9. Failed deployment
- **Detection:** the `civicsignal-deploy` run fails (gate, image build, agent, `/readyz`, smoke); error alerts right after a release.
- **Immediate containment:**
  - If the migrate job failed, the agent stops and the old containers keep serving. Do not retry blindly.
  - If the new version is live and failing, roll back to the previous digests.
- **Investigation:**
  - The run logs (which step failed).
  - Migrate job output: the failing statement's transaction was rolled back.
  - Config validation messages: a missing or invalid variable stops startup with its name.
  - Image pull errors (registry auth, digest).
- **Recovery:**
  - Fix forward with a new commit through CI and staging. A failed migration is replaced by a new migration, never edited once locked.
  - If a migration rewrote data wrongly: DISASTER_RECOVERY_RUNBOOK.md § 5.2.
- **Validation:** a new deploy run passes the gate, readiness and smoke; there is no error-rate increase for 30 minutes.
- **Audit records:** deploy run links; the change log with SHA, digests, rollback and approver.
- **Escalation:** SEV-1 if production is down or data was changed; otherwise SEV-3 (the old version kept serving).
- **Customer communication:** only if users were affected (outage window, feature regression).

## 10. Corrupted data
Covers wrong analytics, broken invariants, a wrong mass update, or an audit-chain verification failure.
- **Detection:** customer reports of impossible numbers; application errors on reading; `audit_verify_chain` failure; reconciliation drift; QA regression tests failing on production-like data.
- **Immediate containment:**
  1. Stop the writer that caused it: disable the job, rule or route, or stop the worker.
  2. Snapshot the database **before** any corrective change.
  3. Set a legal hold if an audit chain failed: that may be tampering, so treat it as section 11 too.
- **Investigation:**
  - Scope: tables, tenants and time range.
  - Cause: a deployment, a migration, an operator action or an external actor (audit events, deploy log).
- **Recovery:**
  - **Small and identifiable:** a reviewed correction script, run under the incident, on a staging copy first.
  - **Large:** PITR into a separate instance and copy the correct data back for the affected scope only. Never roll back other tenants' later writes. DISASTER_RECOVERY_RUNBOOK.md § 5.3.
  - Derived data (analytics aggregates, alert activity) can be rebuilt (RUNBOOK.md § Analytics aggregates, Rebuilding alert aggregates).
- **Validation:** invariants hold (row counts, reconciliation, audit chains); the customer confirms the corrected figures.
- **Audit records:** incident record; correction scripts and their output hashes; before and after snapshots.
- **Escalation:** SEV-1 for audit-chain failure or loss of customer data; SEV-2 for derived-data errors.
- **Customer communication:** which reports or figures were wrong, for which period, and corrected versions. Reports already sent to third parties are listed so the customer can follow up.

## 11. Unauthorized administrative activity
- **Detection:**
  - unexpected `platform_admin.granted` or platform commercial audit entries;
  - role changes in tenant audit logs (owner or admin added);
  - retention or legal-hold changes;
  - deletion requests approved unexpectedly;
  - database logins outside the bastion;
  - deploys without a matching change request.
- **Immediate containment:**
  1. Revoke the actor's sessions and disable the account.
  2. Revoke platform-admin rights (owner connection: `UPDATE users SET is_platform_admin = false WHERE id = …`, then record it).
  3. Set legal holds on the affected tenants, to freeze deletion and retention.
  4. Rotate any credentials the actor could see.
  5. Suspend pending deletion requests.
- **Investigation:**
  - Full audit trail of the actor (tenant and platform).
  - Deploy history and GitHub audit log.
  - Bastion and session-manager logs.
  - Verify the audit chains, to rule out tampering.
- **Recovery:** reverse the unauthorized changes through audited operations (role changes, re-applied policies). Restore deleted data per section 10 if needed.
- **Validation:** the role and permission state matches the approved list; audit chains verify; no further activity from the actor.
- **Audit records:** all of the above, preserved under legal hold. Revocations are themselves audited.
- **Escalation:** SEV-1. Management and counsel; law enforcement per counsel.
- **Customer communication:** affected organizations, with the facts of what was accessed or changed in their organization.

---

## After every incident
- A blameless review within 10 business days: timeline, root cause, detection gap, what worked, actions with owners and dates.
- Control changes go into SECURITY.md, PRODUCTION_READINESS_ASSESSMENT.md and, if an alert was missing or noisy, `infra/monitoring/alerts.yml`.
- Close legal holds only with counsel's approval.

## Contacts (fill in per deployment)
| Role | Name | Primary contact | Backup |
|---|---|---|---|
| Incident commander rota | | | |
| Recovery owner | | | |
| Database operator | | | |
| Key custodian | | | |
| Counsel / DPO | | | |
| Hosting provider support | | | |
| Customer pilot contact | | | |
