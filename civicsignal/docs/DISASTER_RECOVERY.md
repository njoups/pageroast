# Disaster recovery

> No production environment exists yet, so none of these scenarios has been exercised in production. Only the
> database restore path has been tested, in a development container (see [BACKUP_AND_RECOVERY.md](BACKUP_AND_RECOVERY.md#verification-record)).
> RPO and RTO are targets set per deployment and must be proven by a drill before they are promised to anyone.

## Scope and principles
- **Single source of truth:** PostgreSQL. API, worker and web are stateless and are redeployed from images by digest. Redis is transient.
- **Restore to new, never in place.** Every recovery creates a new database or instance and repoints the deployment, which keeps the failed one for investigation.
- **Same region and jurisdiction.** Recovery infrastructure must sit in the approved hosting location. Moving data to another region or country is a legal decision, not an operational one (see DATA_GOVERNANCE.md, open items).
- **Declare, then act.** The recovery owner declares a disaster, which starts the [incident process](INCIDENT_RESPONSE.md). Recovery steps are logged with timestamps in the incident record.

## Scenarios

| Scenario | Detect | Recover | Expected data loss |
|---|---|---|---|
| API or web replica crash | `/health/live` fails; orchestrator restarts it | Automatic restart; redeploy the last good digest if it crash-loops | None |
| Worker crash | Compose healthcheck (`worker-health.js`, heartbeat); `civicsignal_queue_jobs` and `civicsignal_queue_lag_seconds` grow, `civicsignal_workers` drops | Restart. Stale runs are reclaimed by the sweeps; schedulers re-enqueue due work. | None (jobs retried) |
| Redis loss | `/health/ready` reports `redis: down`; queue gauges vanish | Recreate Redis (empty). Schedulers repopulate queues on their next tick. Rate-limit windows reset. | Queued but unstarted jobs are re-derived from database state; notifications in flight may be sent twice (receivers de-duplicate on delivery id) |
| Bad deployment | Readiness check in `civicsignal-deploy.yml` fails, or error rate rises | [Rollback](DEPLOYMENT.md#rollback) to the previous image digests | None, unless a migration changed data (see the migration rule in DEPLOYMENT.md) |
| Bad migration or data corruption | Errors, failed invariants, audit-chain verification failure | Stop writers (scale API and worker to 0). PITR to just before the change, into a new instance. Verify. Repoint. | Writes after the recovery point |
| Accidental bulk deletion (operator or approved deletion request) | Audit events `deletion.completed`, `retention.applied` | PITR into a **separate** instance. Export the affected records under the incident record. The data owner decides whether to re-import. Never roll the live database back over other tenants' later writes. | None for other tenants |
| Database instance or zone failure | Managed-service alarms; readiness `database: down` | Managed failover (multi-AZ) if configured; otherwise PITR into a new instance | Per the managed service; with PITR, minutes |
| Region or provider loss | Provider status; total outage | Restore the latest replicated snapshot or logical dump into the standby location (if one is approved), redeploy images, update DNS | Up to the cross-region copy interval |
| Compromise (credentials, host or insider) | Alerts, audit anomalies, chain verification failure | Follow the INCIDENT_RESPONSE.md containment steps first. Rotate all secrets. Rebuild hosts from images. Restore from a backup taken before the compromise if integrity is in doubt. | Depends on the integrity decision |
| Loss of `CREDENTIALS_KEY` | Webhook deliveries and connector credentials fail to decrypt | Restore the key from the secret manager's version history. If it is truly lost: rotate, then re-enter connector credentials and webhook secrets (RUNBOOK.md) | Encrypted secrets only; no tenant content |

## Recovery procedure (database-level disaster)
1. **Declare:** the recovery owner opens an incident (SEV-1) and names the incident commander and database operator.
2. **Freeze writes:** scale `worker` to 0 first (it writes on schedules), then `api`. Put the web tier in maintenance (proxy returns 503).
3. **Choose the recovery point:** the last known-good timestamp, from audit events and the deployment log. Record why it was chosen.
4. **Restore** into a new instance (PITR), or with `scripts/restore.sh` from a logical dump.
5. **Verify before reopening:**
   - Run `verify-restore.sh`-equivalent checks. For PITR, run steps 4–6 against the new instance: row counts are plausible, forced RLS holds, app-role privileges equal those in the last manifest, and every audit chain verifies.
   - Check that `/health/ready` reports `migrations: current`.
   - Do a smoke test: log in, open the dashboard, open one report, verify one webhook secret decrypts.
6. **Repoint** `DATABASE_URL` and `MIGRATION_DATABASE_URL` through the secret manager. Deploy the same image digests. Run the readiness check.
7. **Reopen:** scale `api` up first, then `worker`, and watch metrics for 30 minutes.
8. **Communicate** the data-loss window to affected tenants (INCIDENT_RESPONSE.md, communications).
9. **Afterwards:**
   - Re-apply deletion requests executed after the recovery point (BACKUP_AND_RECOVERY.md).
   - Keep the failed instance under legal hold until the review closes.
   - Write the post-incident review.

## Drill programme
- **Quarterly:** in staging, restore the latest production-like backup with `verify-restore.sh`. Record the duration as the measured restore time.
- **Twice a year:** a full staging failover. Freeze, PITR, repoint, reopen, and time each step against the RTO.
- **After every migration that rewrites data:** run a drill on a pre-migration backup.

Record each drill in BACKUP_AND_RECOVERY.md (verification record): date, environment, recovery point, measured RPO and RTO, and issues.
A target that has not been met in a drill is reported as *not met*, not as achieved.
