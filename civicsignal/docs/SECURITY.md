# Security

> No certification or compliance is claimed. Controls listed as *planned* are not implemented.

## Implemented controls
Status of each control as of 2026-10-20. "Tested" means an automated test exercises it (see IMPLEMENTATION_STATUS.md).
Findings, open risks and acceptance criteria: [PRODUCTION_READINESS_ASSESSMENT.md](PRODUCTION_READINESS_ASSESSMENT.md).

| Control | Status |
|---|---|
| Passwords hashed with scrypt (N=2^15, minimum enforced in production; per-user salt, timing-safe compare) | ✅ |
| Opaque session tokens (256-bit); only SHA-256 stored; cookie `__Host-cs_session` (httpOnly, Secure, SameSite=Lax, host-only) when `COOKIE_SECURE` | ✅ tested |
| Session absolute expiry (`SESSION_TTL_SECONDS`, default 12 h, ≤ 7 days) and **idle timeout** (`SESSION_IDLE_SECONDS`, default 2 h) | ✅ tested |
| Session revocation: logout, password change and password reset revoke all; users list and revoke sessions (`GET/DELETE /auth/sessions`, `POST /auth/sessions/revoke-others`) | ✅ tested |
| Password recovery: single-use hashed token, 30 min TTL, at most 3 per hour, earlier tokens invalidated, uniform 202 response, token in URL fragment, 503 without SMTP | ✅ tested |
| RLS tenant isolation, forced, non-owner role; cross-tenant route matrix (404) and DB-level checks for every tenant table, job payloads and artifact downloads | ✅ tested |
| Role-permission matrix enforced server-side; `integrations:manage` (owner, admin) for webhooks and deliveries | ✅ tested |
| Audit log: append-only (UPDATE/DELETE revoked + trigger), **per-tenant SHA-256 hash chain** (tamper-evident), event id, actor, action, target, outcome, request id; credential-like metadata redacted | ✅ tested |
| Denied tenant access audited (`authz.denied`), failed logins and resets audited with outcome `failure` | ✅ tested |
| Input validation (whitelist, forbid unknown properties); body limits → 413/400, never 500 | ✅ tested |
| Rate limits on register, login, password change, reset request, reset confirm and invitation accept, **shared across instances via Redis**; cannot be disabled in production | ✅ tested |
| CSP with per-request nonce and `strict-dynamic` (scripts); `style-src 'unsafe-inline'` remains | ✅ verified in the production container |
| CSRF: SameSite=Lax; mutating requests with a foreign `Origin` (or `Sec-Fetch-Site: cross-site`) rejected; JSON bodies only | ✅ tested |
| Open redirects and `javascript:` links: `safeNext` and `safeHref` on the web side | ✅ tested |
| SSRF: registered sources only; private, loopback, link-local, metadata, IPv6 transition and NAT64 ranges blocked at connect time | ✅ tested |
| Configuration validated at startup; production refuses insecure settings (DEPLOYMENT.md) | ✅ tested |
| Logs: structured, with request id, user and tenant ids; secrets redacted (URL credentials, bearer tokens, secret query parameters, sensitive keys) | ✅ tested |
| `/metrics` requires a bearer token (timing-safe), 404 when unset; Swagger off in production by default | ✅ tested |
| User enumeration: login and reset are uniform; **registration reveals existing emails** (documented trade-off; disable open registration in production) | 🟡 |
| MFA | ⬜ **not implemented**: the local identity provider does not support it; an OIDC IdP with MFA is required before production |
| Dependency, licence, secret and image scanning in CI | ✅ (SUPPLY_CHAIN.md) |
| Secrets | env or secret manager only; `.env.example` holds empty placeholders; secret scan of tree and history gates CI | ✅ |

## Threat model (summary)
| Threat | Mitigation |
|---|---|
| Cross-tenant data access | RLS + guard + 404 on non-membership |
| Privilege escalation via role change | Only owner can grant admin/owner; last owner cannot be demoted/removed |
| Platform-admin overreach | No implicit tenant permissions; break-glass planned (M6) |
| Session theft | httpOnly `__Host-` cookie, hashed storage, absolute + idle expiry, user-visible session list and revocation |
| Credential stuffing | Redis-shared per-IP and per-account limits, scrypt cost; login is CPU-bound, so an edge rate limit is required in production (LOAD_TESTING.md) |
| Prompt injection from collected content (M3) | Content wrapped in nonce-tagged untrusted blocks (forged tags neutralised); no tools, DB or authorization reachable from model output; schema validation; every quote/entity/evidence must occur verbatim in the source; summary refs mapped only to records supplied to that call; viewers see only claims whose records they can access |
| AI cost abuse (M3) | Reprocess/backfill need `analysis:reprocess`, are audited and rate-limited per tenant; per-tenant daily/monthly quotas checked when work starts; provider requests-per-minute gate |
| AI key exposure (M3) | Key read from server env only; ambient SDK env ignored; never logged, stored or returned by the API |
| SSRF via connector URLs (M2) | allow-list of registered sources, block private IP ranges |
| SSRF via webhooks (M4) | HTTPS only, connector IP policy at connect time, no redirects, verification handshake before any payload, timeouts and size limits |
| Webhook spoofing/replay (M4) | HMAC-SHA256 over timestamp + body; receivers reject stale timestamps; per-delivery id for de-duplication; secret rotation with grace period; secrets encrypted at rest, shown once |
| Email header injection (M4) | single plain recipient address, CR/LF stripped from subjects, coverage text HTML-escaped |
| Malformed or abusive rule expressions (M4) | strict schema (unknown keys rejected, bounded numbers and look-back), keyword expressions via the bounded query parser, never SQL or code |
| Notification floods (M4) | dedup per rule+subject, cooldown, escalation once per level, per-channel rate limits, daily quota per organization (excess recorded as suppressed) |
| Access to investigation notes (M4) | notes readable only with `alerts:read` and project visibility; not copied into audit logs or webhook payloads; append-only |
| Cross-tenant alert data (M4) | forced RLS on every alerting table; recipients/assignees validated against membership and project access at write and send time |
| Audit tampering | append-only grants + trigger; per-tenant hash chain whose head the app role cannot read or write; `audit_verify_chain` detects edits, deletions and reordering; verified after every restore drill |
| Restore widening privileges | backups keep ACLs; restore applies them exactly; drill compares a privilege fingerprint and fails on difference |
| Prompt-injected cost or data exfiltration via summaries | quota and rate limits on summaries; provider input capped; output is evidence-checked |

## Data-flow (M1)
Browser → Next.js (same-origin proxy) → API → Postgres. Passwords never leave the API; tokens only as httpOnly cookies.

## Access-control matrix
Generated from `apps/api/src/authz/permissions.ts`; a test fails if this table drifts.

<!-- MATRIX:START -->
| Permission | owner | admin | project_manager | analyst | report_viewer |
|---|:-:|:-:|:-:|:-:|:-:|
| `org:read` | ✔ | ✔ | ✔ | ✔ | ✔ |
| `org:update` | ✔ | ✔ |  |  |  |
| `members:read` | ✔ | ✔ | ✔ | ✔ |  |
| `members:invite` | ✔ | ✔ |  |  |  |
| `members:update_role` | ✔ | ✔ |  |  |  |
| `members:remove` | ✔ | ✔ |  |  |  |
| `projects:read` | ✔ | ✔ | ✔ | ✔ | ✔ |
| `projects:create` | ✔ | ✔ | ✔ |  |  |
| `projects:update` | ✔ | ✔ | ✔ |  |  |
| `projects:archive` | ✔ | ✔ | ✔ |  |  |
| `projects:delete` | ✔ | ✔ |  |  |  |
| `projects:manage_members` | ✔ | ✔ | ✔ |  |  |
| `audit:read` | ✔ | ✔ |  |  |  |
| `sources:read` | ✔ | ✔ | ✔ | ✔ |  |
| `sources:manage` | ✔ | ✔ | ✔ |  |  |
| `mentions:read` | ✔ | ✔ | ✔ | ✔ |  |
| `alerts:read` | ✔ | ✔ | ✔ | ✔ |  |
| `alerts:acknowledge` | ✔ | ✔ | ✔ | ✔ |  |
| `alerts:manage` | ✔ | ✔ | ✔ |  |  |
| `reports:read` | ✔ | ✔ | ✔ | ✔ | ✔ |
| `reports:generate` | ✔ | ✔ | ✔ | ✔ |  |
| `billing:read` | ✔ | ✔ |  |  |  |
| `billing:manage` | ✔ |  |  |  |  |
| `retention:manage` | ✔ | ✔ |  |  |  |
| `data:export` | ✔ | ✔ |  |  |  |
| `data:delete` | ✔ |  |  |  |  |
| `analysis:reprocess` | ✔ | ✔ | ✔ |  |  |
| `ai:settings` | ✔ | ✔ |  |  |  |
| `integrations:manage` | ✔ | ✔ |  |  |  |

Platform administrators hold **no** tenant permissions. Project-scoped reads for project_manager, analyst and report_viewer are further limited to projects they are assigned to.
<!-- MATRIX:END -->

## Audit log: retention and access
- **Fields:** event id (uuid), tenant, actor user, action, target type and id, outcome (`success`, `failure`, `denied`), request id (correlation id, also in access logs), client IP, redacted metadata, timestamp, chain hashes.
- **Immutability:**
  - `civicsignal_app` cannot UPDATE or DELETE `audit_events`, and a trigger also refuses.
  - Each insert extends the tenant's hash chain under a row lock. `audit_chain_heads` is invisible to the app role.
  - Verify with `SELECT * FROM audit_verify_chain('<tenant id>')` and `audit_verify_head('<tenant id>')` (owner).
  - The owner role can still rewrite history *and* recompute the chain. Detecting that requires exporting chain heads to an external, append-only store (open item).
- **Retention:**
  - Audit events are not deleted by retention jobs. The `audit_events` retention policy must be ≥ 365 days, and is reported, not enforced.
  - Removing audit history requires an owner-level operation outside the application, under the customer's records policy.
- **Access:**
  - Tenant owners and admins read their tenant's audit log through the API (`audit:read`). Platform admins have no tenant access.
  - Operators read through the owner connection only during an incident, which is itself logged by the database platform.
- **Never recorded:** passwords, session or reset tokens, API keys, webhook secrets, ciphertexts or connector credentials. Keys matching credential patterns are replaced with `[redacted]`.

## Key and secret rotation
| Secret | Rotation | Effect |
|---|---|---|
| `CREDENTIALS_KEY` (AES-256-GCM) | RUNBOOK.md, rotating `CREDENTIALS_KEY` | Existing ciphertexts become unreadable: re-enter connector credentials and rotate webhook secrets |
| Webhook signing secret | Per endpoint, in the UI or API, with a grace period | Receivers accept old and new during the grace period |
| `civicsignal_app` password | `APP_DB_PASSWORD=<new> npm run migrate` (owner), then update `DATABASE_URL` and redeploy | Brief reconnect |
| Owner and migration password | Managed DB console; update `MIGRATION_DATABASE_URL` in the secret manager | Migrate task only |
| `REDIS_PASSWORD` | Redis `CONFIG SET requirepass` or managed console, then `REDIS_URL`, then redeploy | Queues reconnect |
| `METRICS_TOKEN` | Set the new value in the secret manager and the scraper, then redeploy | Scrapes fail until both are updated |
| `ANTHROPIC_API_KEY`, SMTP credentials | At the provider; set the new value; restart api and worker | — |
| All sessions | `UPDATE sessions SET revoked_at = now() WHERE revoked_at IS NULL` | Everyone logs in again |

Rotate on suspicion of exposure immediately (INCIDENT_RESPONSE.md), and otherwise at least yearly.
Staging and production never share a secret.

## Incident response, backup and recovery
See [INCIDENT_RESPONSE.md](INCIDENT_RESPONSE.md), [BACKUP_AND_RECOVERY.md](BACKUP_AND_RECOVERY.md) and [DISASTER_RECOVERY.md](DISASTER_RECOVERY.md).
No production backup or restore exists yet. The verified drills and their environments are listed in BACKUP_AND_RECOVERY.md.
