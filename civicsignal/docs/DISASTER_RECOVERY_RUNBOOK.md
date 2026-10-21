# Disaster Recovery Runbook

> **Status (2026-10-21):** no staging or production environment exists, so no production backup exists and no production
> or PITR restore has ever been performed. Restores of logical backups have been verified in disposable databases only
> (see [Verification record](#verification-record)). **RPO and RTO below are targets**, set per deployment. They become
> commitments only after a drill on that deployment's infrastructure meets them. Report a target missed in a drill as
> *not met*.

This runbook replaces `DISASTER_RECOVERY.md` and `BACKUP_AND_RECOVERY.md`; both now point here.
Related documents:
- [INCIDENT_RESPONSE_RUNBOOK.md](INCIDENT_RESPONSE_RUNBOOK.md): declaring incidents, communications and evidence;
- [DEPLOYMENT.md](DEPLOYMENT.md): environments, migrations and rollback.

## 1. Principles
- **PostgreSQL is the only system of record.**
  - API, worker and web are stateless and are redeployed from images by digest.
  - Redis is transient: queues are re-derived from database state.
  - Report files are stored in PostgreSQL, so restoring the database restores them.
  - There is no object storage and there are no uploaded documents.
- **Restore to new, never in place.** Every recovery creates a new database or instance and repoints the deployment. The failed one is kept for investigation. `restore.sh` refuses a non-empty target.
- **Never test recovery against a live database.** Drills restore into scratch databases. Since 2026-10-21 the drill never changes the shared `civicsignal_app` role (see the verification record), but run it against staging or a separate server wherever possible.
- **Same jurisdiction.** Backups, replicas and recovery infrastructure stay in the approved hosting location. Moving data elsewhere is a legal decision (DATA_GOVERNANCE.md).
- **Declare, then act.** The recovery owner declares the incident (INCIDENT_RESPONSE_RUNBOOK.md) and logs every step with a timestamp.

## 2. What must be recoverable

| Item | Contents | Recovery source | Notes |
|---|---|---|---|
| PostgreSQL | All tenant data, the hash-chained audit log, report files (`report_artifacts.data`), encrypted credentials, the usage ledger and invoices | Managed PITR + snapshots (primary); `scripts/backup.sh` encrypted logical dumps (secondary, portable) | Everything else is rebuilt from it |
| Redis | BullMQ queues, rate-limit windows, heartbeats | Not backed up | After loss, schedulers re-enqueue due work; stale runs are reclaimed |
| `CREDENTIALS_KEY` | Decrypts connector credentials and webhook secrets | Secret manager (versioned), stored **separately** from database backups | Without it a restored database's credentials are unreadable |
| Backup decryption key (GPG private key) | Decrypts logical dumps | Offline / HSM / restricted secret-manager entry | Never on the hosts that make backups |
| Configuration | `app.env`, `migrate.env`, Compose and Caddy files | Secret manager + this repository at the deployed commit | Templates: `infra/env/*.env.example` |
| Container images | api, web | Registry by digest; rebuildable from git at the same commit | The digests of every deployment are in the change log and the deploy run summary |
| TLS state | Caddy certificates and ACME account (`caddy_data` volume, single-host option) | Re-issued automatically if lost (subject to CA rate limits); include the volume in host backups | With a load balancer, the provider holds certificates |

## 3. Targets (to be agreed per deployment)

| Parameter | Proposed target | Achieved by | Proven? |
|---|---|---|---|
| **RPO** | ≤ 15 min (managed PITR); 24 h if only nightly logical dumps exist (single-host pilot) | WAL archiving / PITR; nightly `backup.sh` | **No**: no environment exists |
| **RTO** | ≤ 4 h | PITR to a new instance + repoint + redeploy by digest | **No** |
| PITR retention | 35 days (or the provider maximum, if lower) | Managed service setting | No |
| Logical backups | Nightly, retained 35 days, plus 12 monthly copies | `backup.sh` from the operator's backup job | No |
| Restore drill | Quarterly on staging; after every migration that rewrites data | `verify-restore.sh` | Local and CI only |

The customer's business-continuity requirements override these proposals. Record the agreed values in the pilot agreement (PILOT_OPERATIONS_RUNBOOK.md).

## 4. Backups

### 4.1 Primary: managed PostgreSQL (option B in DEPLOYMENT.md)
- Automated snapshots and point-in-time recovery on, in the approved region, encrypted at rest with a customer-managed key where available.
- Backup and snapshot access is limited to the database-operator role, and every console or API access is logged.
- Alert on backup failure using the provider's notifications (the application cannot see managed snapshots).
- **None of this is configured anywhere yet.**

### 4.2 Secondary: encrypted logical dump (all options; the only backup on a single host)
```bash
# From a host inside the database network, nightly (e.g. a systemd timer or the platform's scheduled job):
MIGRATION_DATABASE_URL=<owner connection from the secret manager> \
BACKUP_GPG_RECIPIENT=<backup public key id> \
BACKUP_METRICS_FILE=/var/lib/node_exporter/textfile/civicsignal_backup.prom \
  scripts/backup.sh /var/backups/civicsignal/civicsignal-$(date -u +%FT%H%MZ).dump
# then copy *.dump.gpg, *.manifest and *.sha256 to off-host storage (versioned, object lock, approved region)
```
- Uses `pg_dump` custom format, owner connection, `umask 077`. **Privileges are kept**, so a restore reproduces the app role's exact grants.
- The manifest holds applied migrations, exact per-table row counts (all tenants) and the app-role privilege fingerprint. A sha256 file covers the dump and the manifest.
- `BACKUP_GPG_RECIPIENT` encrypts to a public key and removes the plaintext. Without it the script warns, because the dump contains every tenant's data.
- **Storage access:** the backup job can write but not delete (object lock / write-only credentials). Restores use a separate read role held by the database operator.
- **Failure alerts:** `BACKUP_METRICS_FILE` records the last success. `CivicSignalBackupStale` pages after 26 h without a success, and `CivicSignalBackupMetricMissing` fires if backups never ran (`infra/monitoring/alerts.yml`). A failed run leaves the old timestamp, so the alert still fires.
- **Single-host pilot:** also back up the host's `caddy_data` volume and `/etc/civicsignal` (encrypted, through the secret manager rather than as files).

## 5. Restore procedures

### 5.1 Prove a backup (drill; safe on any server)
```bash
ADMIN_DATABASE_URL=<superuser>/postgres scripts/verify-restore.sh /path/civicsignal-<date>.dump.gpg
```
1. Verifies the checksums of the dump and the manifest.
2. Decrypts (GPG) and restores into a **new** scratch database `restore_drill_<timestamp>`.
3. Checks every backed-up migration is present (newer ones are listed).
4. Checks every table's exact row count against the manifest.
5. Checks forced RLS on every table, an app role that is neither superuser nor BYPASSRLS and owns nothing, and privileges identical to the manifest.
6. Verifies every audit hash chain against its stored head.
7. Drops the scratch database (`KEEP_RESTORE_DB=1` keeps it for a manual smoke test).

The drill does **not** set the `civicsignal_app` password, so it is safe next to a live database on the same server.
It does **not** prove that the application works against the data (do 5.4), or that `CREDENTIALS_KEY` matches (decrypt one connector credential after a real restore).

### 5.2 Database-level disaster (corruption, bad migration, lost instance)
1. **Declare** a SEV-1 (INCIDENT_RESPONSE_RUNBOOK.md) and name the incident commander and database operator.
2. **Freeze writes:**
   - stop `worker` first, because it writes on schedules (`docker compose … stop worker`, or scale to 0);
   - then stop `api`;
   - the edge then serves the web app's error page. On option B, put the load balancer in maintenance mode.
3. **Choose the recovery point:** the last known-good time, from audit events, the deploy log and the incident timeline. Record the reason.
4. **Restore into a new instance:**
   - Managed: PITR to the chosen time into a new instance.
   - Logical:
     ```bash
     TARGET_DATABASE_URL=<owner>@<new instance>/civicsignal APP_DB_PASSWORD=<from secret manager> scripts/restore.sh <dump>
     ```
     Set `APP_DB_PASSWORD` only on a **new** server, because it sets the cluster-wide app role's password.
5. **Verify** before reopening:
   - for a logical restore, run the 5.1 checks on the new database (`KEEP_RESTORE_DB` flow, or the same SQL);
   - for PITR, run steps 3–6 of the drill against the new instance;
   - the API's `/health/ready` must report `migrations: current`.
6. **Repoint** `DATABASE_URL` and `MIGRATION_DATABASE_URL` in the secret manager. Redeploy the **same** image digests (a code rollback only if the incident was a bad release).
7. **Reopen:** start `api` and run `scripts/smoke.mjs`. Then start `worker`, and watch error rate, queue lag and heartbeats for 30 minutes.
8. **Communicate** the data-loss window (writes after the recovery point) to affected organizations.
9. **Afterwards:**
   - re-apply deletion requests executed after the recovery point (section 7);
   - revoke sessions if credentials were involved: `UPDATE sessions SET revoked_at = now() WHERE revoked_at IS NULL` as owner;
   - re-run report runs that were in flight;
   - keep the failed instance under legal hold until the review closes.

### 5.3 Other scenarios

| Scenario | Detect | Recover | Expected data loss |
|---|---|---|---|
| API or web crash | `/healthz`, `/health/ready`, `CivicSignalApiDown` | Containers restart (`restart: unless-stopped`); on a crash loop, roll back to the previous digests | None |
| Worker crash | `CivicSignalNoWorkers`, queue lag | Restart. Stale runs are reclaimed; schedulers re-enqueue | None (retried) |
| Redis lost | Readiness `redis: down` | Recreate empty Redis (managed: new instance), restart api and worker | Unstarted jobs are re-derived. In-flight notifications may be re-sent; receivers de-duplicate on delivery id |
| Bad deployment | `/readyz` or smoke test fails in the deploy run, or error-rate alerts | DEPLOYMENT.md § Rollback | None unless a migration rewrote data (then 5.2) |
| Accidental bulk deletion | `deletion.completed` / `retention.applied` audit events | PITR into a **separate** instance. Export the affected tenant's records under the incident; the data owner decides on re-import. Never roll the live database back over other tenants' later writes | None for other tenants |
| Host lost (single-host pilot) | Everything down | New host. Restore the latest logical dump (5.2 step 4, new server), restore `/etc/civicsignal` from the secret manager, deploy the recorded digests, update DNS if the IP changed | Up to 24 h (nightly dump) |
| Zone or instance failure (managed) | Provider alarms | Managed failover (multi-AZ); otherwise 5.2 with PITR | Minutes |
| Region or provider loss | Total outage | Restore the latest off-region copy, if one is approved, into the standby location; redeploy; DNS | Up to the copy interval |
| `CREDENTIALS_KEY` lost | Credential decryption fails | Restore it from the secret manager's history. If truly lost: rotate, then re-enter connector credentials and webhook secrets (RUNBOOK.md) | Encrypted secrets only |
| Compromise | See INCIDENT_RESPONSE_RUNBOOK.md | Contain first. Restore from a backup taken before the compromise if integrity is in doubt | Integrity decision |

### 5.4 After any restore: application checks
- `scripts/smoke.mjs` with the smoke account.
- Open one report and download it.
- Confirm one connector credential decrypts (connection test on an internal connector).
- Check that `/metrics` shows workers and queues draining.

## 6. Restore test procedure (staging, quarterly)
1. Take a fresh backup of staging (4.2), or use the latest off-host copy, which tests the copy too.
2. Run `verify-restore.sh` against **staging's** server or a separate scratch server, never against production.
3. Time it from the start of the download to the end of the drill. This is the measured logical restore time.
4. With `KEEP_RESTORE_DB=1`, point a throwaway API at the scratch database (`APP_ENV=local`, internal network only) and run `scripts/smoke.mjs`. Then drop it.
5. For managed PITR: restore staging to a timestamp 1 h ago into a new instance and run the drill's checks 3–6 against it. Time it; this is the measured RTO component.
6. Record the date, environment, backup age, durations, result and issues in the verification record below.

## 7. Backups and deletion
- Deletion requests and retention purges remove data from the **live** database only. Copies remain in backups until those backups expire. The deletion workflow tells requesters this (DATA_GOVERNANCE.md).
- After restoring a backup older than an executed deletion, re-apply the deletion: an operator re-creates and approves the same scopes from the `deletion_requests` audit trail.
- Legal holds apply to backups. Do not shorten backup retention while a hold is active.

## 8. Roles

| Role | Responsibility |
|---|---|
| Recovery owner (named + deputy, per environment) | Owns this runbook, schedules drills, decides on a restore, signs off verification |
| Database operator | Performs restores; holds `ADMIN_DATABASE_URL` and the backup read role |
| Key custodian | Releases `CREDENTIALS_KEY` and the backup decryption key. Two-person rule recommended for production |
| Communications lead | Customer updates (INCIDENT_RESPONSE_RUNBOOK.md) |

## Verification record

| Date | Environment | What was run | Result |
|---|---|---|---|
| 2026-10-19 | Local PostgreSQL 16 (dev container) | First backup and restore check | Row counts matched. **Superseded:** the restore widened app-role privileges (next row) |
| 2026-10-20 | Local dev database (2,839 rows, 4 audit chains) | `backup.sh` → `verify-restore.sh` | Passed after a fix: dumps keep privileges and the drill compares a privilege fingerprint. A negative test (altered manifest) failed at step 5 as intended |
| 2026-10-20 → | CI (GitHub Actions, PostgreSQL 16 service) | Empty database → migrate → backup → verify, on every push | Passing |
| 2026-10-21 | `infra/compose.production.yml` stack in this container (staging mode, `selfhosted-data`, 84 tables, 2 audit chains) | **Encrypted** backup (throwaway GPG key) → `verify-restore.sh` on the same server as the live stack | **Two defects found and fixed:** (1) the encrypted path failed (`gpg` refused to overwrite its temp file); (2) the drill reset the cluster-wide `civicsignal_app` password, so the live API's readiness went to 503. Recovered by re-running the migrate job. After the fixes the drill passed all 6 steps and the live API stayed ready, including after a restart with fresh connections |
| 2026-10-21 → | CI job `stack` (`scripts/stack-test.sh`) | The same drill against the production Compose stack on every push | Passing locally (offline-assembled images); first CI run pending |

**Never done:** a PITR restore, a restore on staging or production infrastructure, a measured RTO, or a host-loss rebuild.
