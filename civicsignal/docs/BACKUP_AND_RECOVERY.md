# Backup and recovery

> **Status: no production or staging environment exists, so no production backup exists and no production restore has
> been performed.** What *has* been verified is listed under [Verification record](#verification-record), with the
> environment each check ran in. RPO and RTO below are **targets to be configured and proven**, not achieved figures.

## What must be recoverable

| Store | Contents | Recovery source | Notes |
|---|---|---|---|
| PostgreSQL | All tenant data, audit log (hash-chained), report artifacts (`report_artifacts.data`), encrypted credentials | Managed PITR plus snapshots (primary); `scripts/backup.sh` logical dumps (secondary, portable) | System of record. Everything else can be rebuilt from it. |
| Redis | BullMQ queues, rate-limit counters, worker heartbeats | Not backed up | Transient. After loss, schedulers re-enqueue due work on their next tick. In-flight jobs are retried from database state (runs left `running` are reclaimed by the stale-run sweeps). Rate-limit windows reset. |
| `CREDENTIALS_KEY` | Encrypts webhook secrets and connector credentials | Secret manager (versioned) | Without it, encrypted values in a restored database cannot be read. Back it up **separately** from database backups. |
| `BACKUP_GPG_RECIPIENT` private key | Decrypts logical dumps | Offline / HSM / secret manager with restricted access | Not stored on the hosts that make backups. |
| Container images | api, web | Registry, by digest (`civicsignal-deploy.yml`) | Rebuildable from git at the same commit. |
| Configuration | Environment variables | Secret manager plus deployment repository | `.env.example` lists every variable. It contains placeholders only. |

## Targets (configure per deployment)

| Parameter | Suggested starting target | Set by | How it is met |
|---|---|---|---|
| **RPO** (maximum data loss) | ≤ 15 min | Data owner with the operator | Managed PostgreSQL PITR (WAL archiving) gives seconds to minutes. Daily logical dumps alone give an RPO of 24 h. |
| **RTO** (time to restore service) | ≤ 4 h | Service owner | Restore PITR to a new instance, repoint `DATABASE_URL`, redeploy images by digest, run the readiness check. |
| Backup retention | 35 days PITR; 12 monthly logical dumps | Data owner and legal | Must not exceed what the retention policy and licences allow (see [Backups and deletion](#backups-and-deletion)). |
| Restore drill | Quarterly in staging; after every major migration | Recovery owner | `scripts/verify-restore.sh` against the latest backup. Record the result below. |

These are proposals for the first deployment. The agency's or customer's business-continuity requirements take precedence.
Record the agreed values in the deployment's runbook.

## Roles

| Role | Responsibility |
|---|---|
| **Recovery owner** (named person plus a deputy, per environment) | Owns this document, schedules drills, decides on a restore during an incident, signs off verification |
| Database operator | Performs the restore (managed service console or CLI), holds `ADMIN_DATABASE_URL` |
| Key custodian | Releases `CREDENTIALS_KEY` and the backup decryption key. Two-person rule recommended for production. |
| Communications lead | Customer and stakeholder updates (see [INCIDENT_RESPONSE.md](INCIDENT_RESPONSE.md)) |

## Backups

### Primary: managed PostgreSQL
Enable automated snapshots and point-in-time recovery on the managed service, encrypted at rest with a customer-managed key where available, in the approved region.
This is infrastructure configuration outside this repository. Confirm and record it per environment. **It has not been configured anywhere yet.**

### Secondary: logical dump (`scripts/backup.sh`)
```bash
MIGRATION_DATABASE_URL=<owner connection> BACKUP_GPG_RECIPIENT=<key id> scripts/backup.sh /secure/path/civicsignal-$(date -u +%F).dump
```
- Writes `pg_dump` custom format using the owner connection, with `umask 077`. **Privileges are kept** so the restore reproduces the application role's exact grants.
- Writes a **manifest** with:
  - applied migrations;
  - exact per-table row counts, read with `row_security = off` so they cover all tenants;
  - a fingerprint of the app role's table, column, function and schema privileges.
- Writes a **sha256** file covering the dump and the manifest.
- With `BACKUP_GPG_RECIPIENT`, the dump is encrypted to a public key and the plaintext is removed. Without it, the script warns: the dump contains every tenant's data and must only be written to encrypted storage.
- Run it from a host inside the database's network. Copy the outputs to separate, access-controlled storage (object storage with versioning and object lock, in the approved region).

## Restore

Always restore into a **new, empty** database. Never restore over a live one. `restore.sh` refuses a non-empty target.

```bash
# 1. Prove the backup first: restores into a scratch database, checks it, then drops it.
ADMIN_DATABASE_URL=<superuser>/postgres scripts/verify-restore.sh civicsignal-2026-10-20.dump[.gpg]
# 2. Restore for real into a new database.
TARGET_DATABASE_URL=<owner>/civicsignal_restored APP_DB_PASSWORD=<from secret manager> scripts/restore.sh civicsignal-2026-10-20.dump
# 3. Point the deployment at it (DATABASE_URL / MIGRATION_DATABASE_URL), deploy, and check /health/ready.
```

`restore.sh` checks the checksum, creates the `civicsignal_app` role if the cluster is new, and restores data and privileges.
It then runs migrations, which apply any migration newer than the backup and set the app role's password.

For PITR, follow the managed service's procedure to create a new instance at the chosen timestamp. Then run step 3, and run `verify-restore.sh`-equivalent checks (steps 4–6 below) against it.

### What `verify-restore.sh` proves
1. The dump and manifest checksums match.
2. The dump restores into a fresh database without errors.
3. Every migration in the backup is present; newer ones applied by the restore are listed.
4. Every table's row count equals the manifest.
5. Forced RLS is on every table, and the app role is neither superuser nor BYPASSRLS and owns nothing. Its privileges equal the manifest: a restore must not widen them.
6. Every audit hash chain verifies (`audit_verify_chain`) and matches its stored head.

It prints counts and verdicts only, never row contents. It does **not** prove:
- that the application works against the restored data (do a smoke login and open a report);
- that `CREDENTIALS_KEY` matches the restored ciphertexts. To check that, verify one webhook or connector credential after the restore.

## After a restore
- Data written after the recovery point is lost. Tell affected tenants which window is affected.
- Sessions in the restored database are as of the recovery point. If the incident involved credential exposure, revoke all of them: `UPDATE sessions SET revoked_at = now() WHERE revoked_at IS NULL` as owner.
- Re-run report generation for runs that were in flight. Ingestion catches up on its next schedule. Alert evaluation recomputes its last 48 hours.
- Audit events recorded after the recovery point are gone. Preserve the old instance (or its final WAL) for the investigation, under legal hold.

## Backups and deletion
- Deletion requests and retention purges remove data from the **live** database only. Copies remain in backups until those backups expire under the backup retention period above.
- The product does **not** promise immediate erasure from backups. The deletion workflow (`docs/DATA_GOVERNANCE.md`) tells requesters this.
- After restoring a backup taken before a deletion was executed, re-apply executed deletion requests. `deletion_requests` rows with status `executed` and their stored record ids are in the live audit trail. Re-applying them is a manual step: an operator re-creates and approves the same scopes.
- Legal holds apply to backups too. Do not shorten backup retention while a hold is active.

## Verification record

| Date | Environment | What was run | Result |
|---|---|---|---|
| 2026-10-19 | Local PostgreSQL 16 (development container) | Earlier backup and restore check | Row counts matched; forced RLS and app-role isolation held. **Superseded:** that restore path widened app-role privileges (see the next row). |
| 2026-10-20 | Local PostgreSQL 16, development database (2,839 rows, 4 audit chains, 82 events) | `backup.sh`, then `verify-restore.sh` | First drill passed steps 1–6. Its step 5 did not compare privileges. A kept restore then showed the app role could UPDATE `audit_chain_heads` and `sessions.token_hash` and DELETE retention ledgers, because `restore.sh` re-granted table-wide privileges. **Fixed:** dumps keep privileges, restore applies them exactly, and the drill compares a 94-object privilege fingerprint. The drill was re-run and passed all 6 steps, including the privilege comparison (one newer migration, 0011, applied after restore). |
| 2026-10-20 | Same | Negative test: manifest privilege line altered, checksums regenerated | Drill failed at step 5 with the differing line, exit code 1, and the scratch database was dropped. |
| 2026-10-20 | Local PostgreSQL 16 (test cluster) | The CI drill step: empty database, migrate, backup, verify | Passed. CI runs this on every push. |

Encryption (`BACKUP_GPG_RECIPIENT`) has not been exercised in a drill yet. No PITR restore has been performed, because no managed database exists.
The first staging deployment must add a row here for both.
