# Incident response

> This is a starting procedure for the operator. It does not replace the customer's or agency's own incident and
> breach-notification obligations. Under Indonesian law, notification duties may apply, for example under UU No. 27/2022
> (Pelindungan Data Pribadi) and sector or agency rules. Their scope, deadlines and recipients must be confirmed with
> qualified Indonesian legal counsel before go-live. Nothing here asserts compliance.

## Severity

| Level | Examples | Response |
|---|---|---|
| **SEV-1** | Confirmed cross-tenant data exposure; credential or key compromise; audit-chain verification failure; total outage; data loss | Page the on-call and the incident commander immediately; work around the clock; tenant communication within the agreed window |
| **SEV-2** | Partial outage (ingestion, reports or alerts stopped for > 1 h); suspected but unconfirmed exposure; one tenant affected | Respond within 1 h during business hours, 4 h otherwise |
| **SEV-3** | Degraded performance; single failed report or connector; security finding with no evidence of exploitation | Next business day |

## Roles
- **Incident commander (IC):** owns the incident, decides, and keeps the timeline. Not the person typing fixes.
- **Operations lead:** containment and recovery actions.
- **Communications lead:** tenant, management and regulator communications, approved by the IC and counsel.
- **Scribe:** timestamped log of facts, decisions and actions, kept in the incident record (not in chat only).
- **Counsel / data-protection officer:** decides on notification duties and wording.

## Procedure

### 1. Detect and declare
Sources:
- alerts on `/metrics` (see RUNBOOK.md, alerts);
- readiness failures;
- `authz.denied` or `auth.login_failed` spikes in `audit_events`;
- tenant reports;
- failure of `audit_verify_chain`;
- secret-scan findings;
- dependency or image advisories.

Open an incident record with time of detection, reporter, initial severity and IC.

### 2. Contain (choose what applies)
| Situation | Action |
|---|---|
| A user account is compromised | Owner or admin removes the membership. The user, or an operator as owner, revokes sessions (`POST /auth/sessions/revoke-others`, or `UPDATE sessions SET revoked_at = now() WHERE user_id = …`). Force a password reset. |
| All sessions are suspect | `UPDATE sessions SET revoked_at = now() WHERE revoked_at IS NULL` (owner connection). Every user must log in again. |
| `CREDENTIALS_KEY` exposed | Rotate the key, then rotate every webhook secret and connector credential (RUNBOOK.md, rotating `CREDENTIALS_KEY`). |
| Database credentials exposed | Rotate the `civicsignal_app` password (`ALTER ROLE` via migrate with a new `APP_DB_PASSWORD`) and the owner password. Redeploy. Review `pg_stat_activity` and connection logs. |
| AI provider key exposed | Revoke it at the provider, set the new key, restart API and worker. Check provider usage for the exposure window. |
| A webhook receiver is compromised | Disable the endpoint (integrations admin) and rotate its secret. |
| Malicious or abusive source content | Disable the source. Do not delete records that may be evidence. Place a legal hold if needed. |
| Suspected cross-tenant exposure | Preserve evidence first (step 3). Identify the code path. Disable the feature behind it (scale down, or block the route at the proxy). Do not hot-patch production without review. |
| Host compromise | Isolate the host from the network. Rebuild from images. Do not reuse the host's secrets. |

### 3. Preserve evidence
- **Set a legal hold** on affected tenants (`PUT /data-governance/controls { legalHold: true }`). This stops retention purges and deletion requests.
- **Export audit events** for the window (owner connection, read-only). Verify each affected chain (`SELECT * FROM audit_verify_chain('<tenant id>')`) and record the result.
- **Keep logs:** API and worker access logs carry `requestId`, `userId` and `tenantId`. Proxy and database logs and the deployment log complete the picture.
- **Snapshot the database** (managed snapshot) before any corrective data change.
- **Record hashes** of exported files in the incident record.

### 4. Eradicate and recover
- Fix the root cause through the normal review and CI path. An emergency change still needs one reviewer and green CI, and is deployed with `civicsignal-deploy.yml` (manual, approved).
- If data integrity is in doubt, recover per [DISASTER_RECOVERY.md](DISASTER_RECOVERY.md).

### 5. Communicate
- **Internal:** status updates at a fixed cadence (SEV-1 hourly), covering what is known, what is not, and the next update time.
- **Tenants:** what happened, what data and period are affected, what was done, what they should do. Send only facts that have been verified.
- **Regulators and data subjects:** as decided by counsel within the legal deadlines. The communications lead keeps copies.
- **Never** include secrets, other tenants' names or data, or unverified speculation in any communication.

### 6. Review
Within 10 business days, a blameless post-incident review covering: timeline, root cause, detection gap, what worked, and actions with owners and dates.
Actions that change controls are reflected in SECURITY.md and PRODUCTION_READINESS_ASSESSMENT.md.

## Contacts (fill per deployment)
| Role | Name | Primary contact | Backup |
|---|---|---|---|
| Incident commander rota | | | |
| Recovery owner | | | |
| Database operator | | | |
| Key custodian | | | |
| Counsel / DPO | | | |
| Hosting provider support | | | |
