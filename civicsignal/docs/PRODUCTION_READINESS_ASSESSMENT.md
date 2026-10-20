# Production readiness assessment

**Date:** 2026-10-20 · **Scope:** `civicsignal/` at the commits listed in [Evidence](#evidence) · **Assessor:** engineering self-assessment, not an independent audit.

> **Conclusion.** The codebase now has the controls a government-facing pilot needs at the application layer. They are tested
> where tests are possible. It is **not production-ready as a service yet**:
> - there is no staging or production environment;
> - there is no managed database with verified PITR;
> - there is no MFA-capable identity provider;
> - no external penetration test has been done;
> - the legal review (UU PDP, residency, source licences) is still open.
>
> Passing tests does not make the platform secure or certified, and **no certification or compliance with any government
> standard is claimed.** The [blocking items](#blocking-before-production) list what must close first.

## 1. Verified architecture

Verified by reading the code and running it in this repository's dev container. These are not design intentions.

| Layer | What exists | How it was verified |
|---|---|---|
| Web | Next.js 16 app router. Same-origin proxy to the API. Per-request CSP nonce with `strict-dynamic`. | Production container served `/login` with a nonce that differs per request (2026-10-20) |
| API | NestJS 11, JSON-only bodies. Origin check on mutating requests. Session cookie `__Host-cs_session` (Secure, httpOnly, SameSite=Lax). Guards: session → tenant membership → permission. | 469 API tests, including the cross-tenant route matrix |
| Worker | BullMQ queues (ingestion, analysis, alerts, reports, notifications, retention). Heartbeat health check. | Load test drove all queues; queue e2e tests |
| Database | PostgreSQL 16 with **forced RLS on every tenant table** and a non-owner app role. The tenant is set per transaction (`withTenant`). Separate owner role for migrations. 11 checksummed migrations. | Migration invariants test; DB-level isolation tests; restore drill step 5 |
| Audit | Append-only `audit_events` (UPDATE/DELETE revoked plus trigger). Per-tenant **SHA-256 hash chain** with a head table the app cannot touch. Outcome and correlation id on every event. | Tamper-detection test; chain verified after restore |
| Identity | Local provider: scrypt N=2^15, opaque 256-bit tokens (hashes stored). Absolute and idle expiry. Session list and revoke. Password reset by email. **No MFA.** | Auth and security e2e tests |
| Ops | `/health/live`, `/health/ready` (DB, Redis, migrations), token-protected `/metrics`. Structured, redacted access logs with request id. | Security e2e; container smoke test |

The full architecture is in [ARCHITECTURE.md](ARCHITECTURE.md), deployment in [DEPLOYMENT.md](DEPLOYMENT.md), and controls in [SECURITY.md](SECURITY.md).

## 2. Findings

Severity reflects impact if exploited or triggered in a multi-tenant government deployment:
- **Critical:** cross-tenant exposure or full compromise;
- **High:** exposure within a tenant beyond the user's role, integrity loss, or a likely outage;
- **Medium:** limited exposure, denial of service, or a missing operational control;
- **Low:** defence in depth.

### 2.1 Fixed in this hardening pass

| ID | Sev. | Finding | Fix | Evidence |
|---|---|---|---|---|
| F1 | High | `GET …/summaries` lacked a `mentions:read` check, so roles without mention access could read AI summaries | Permission added | security e2e route matrix |
| F2 | High | Cluster list and detail exposed labels, events and summary text drawn from projects the caller is not assigned to | `cluster-visibility.ts` filters labels, events and summaries (with a `partial` flag) in clusters, mention analysis, issue detail and the dashboard | analysis and security e2e |
| F3 | High | Webhook endpoints (URLs, secret rotation) and delivery logs were manageable with `alerts:manage` (analysts) | New permission `integrations:manage` (owner and admin). Analysts pick endpoints through `/webhooks/options` (no secrets or URLs). | permission matrix test; security e2e (denial audited) |
| R-1 | High | **Restore widened app-role privileges.** `restore.sh` re-granted table-wide rights, so a restored DB let the app UPDATE `audit_chain_heads` (forge the audit chain head) and `sessions.token_hash`, and DELETE retention ledgers. | Dumps keep privileges and restore applies them exactly. The manifest fingerprints 94 privilege objects, and the drill fails on any difference. Restore refuses dumps without ACLs and non-empty targets. | drill pass plus negative test ([BACKUP_AND_RECOVERY.md](BACKUP_AND_RECOVERY.md#verification-record)) |
| G1 | High | Retention policies were stored but **never enforced**. There was no legal hold and no deletion workflow. | `RetentionService`: licence expiry, metadata, body, derived-analysis and report classes; dry-run counts; ledger; daily tick. Legal hold. Four-eyes deletion requests (mentions, source and search scopes, ≤ 20,000 records). | security e2e (disabled → skipped, hold, apply, cache purge, four-eyes, artifact 410) |
| B1 | High | No verified backup procedure | `backup.sh` (manifest, checksum, optional GPG) plus `verify-restore.sh` (6 checks), run in CI on every push | CI step; local drills |
| M1 | Medium | Compose passed **owner** DB credentials to the api and worker containers | Only `migrate` receives `MIGRATION_DATABASE_URL`; production config refuses owner equal to app | compose; config unit tests |
| M2 | Medium | Quadratic regex in the feed HTML stripper: 200k characters took 3.3 s per item, a worker DoS | Linear `stripTags`, markup capped at 200k characters | unit test (< 500 ms on 2.8M characters) |
| M3 | Medium | Summary generation had no quota check or rate limit (AI cost abuse) | `quotaState` checks plus tenant rate limit; provider body capped at 30k characters | analysis tests |
| M4 | Medium | CSP allowed inline scripts | Nonce plus `strict-dynamic` via `proxy.ts`; static CSP removed | container check |
| M5 | Medium | Sessions had no idle timeout; users could not list or revoke sessions | `SESSION_IDLE_SECONDS` (default 2 h, 300 s–TTL), `last_seen_at`; `GET/DELETE /auth/sessions`, `revoke-others` | security e2e |
| M6 | Medium | No password recovery | Single-use, hashed, 30-minute reset tokens (limit 3 per hour). Uniform 202 response. Revokes all sessions. The link carries the token in the URL fragment, which browsers never send to servers or proxies. 503 when SMTP is not configured. | security e2e |
| M7 | Medium | Audit log was append-only but not tamper-evident; no outcome field | Hash chain (`audit_verify_chain`, `audit_verify_head`), event id, outcome (`success`/`failure`/`denied`) | tamper test |
| M8 | Medium | Rate limits were per-process memory and could be disabled in production | Redis-shared counters (`cs:rl:`); `RATE_LIMIT_ENABLED=false` refused in production | two-instance test |
| M9 | Medium | Secrets could reach logs: stack traces with DB URLs, audit metadata keys | `redactString`/`redact` in logs and the error filter; `scrubMetadata` on audit metadata | unit tests |
| M10 | Medium | No readiness probe or metrics; liveness and readiness not separated | `/health/live`, `/health/ready`, `/metrics` (token, timing-safe) | security e2e |
| M11 | Medium | Mention search degraded with page depth: `offset=1000` took 1,958 ms; p95 was 1.4 s at concurrency 4 | Migration 0011 index plus ids-first paging → 43 ms | [LOAD_TESTING.md](LOAD_TESTING.md); paging e2e |
| M12 | Medium | No `.dockerignore`: host `node_modules`, `.env` and dumps entered the build context, and host modules overwrote `npm ci` output in images | `.dockerignore` | image inspection |
| M13 | Medium | Runtime images had 7 fixable HIGH/CRITICAL OS CVEs (perl-base) and 10 in bundled npm | `apt-get upgrade`; npm, npx and corepack removed from runtime | Trivy rescan: 0 |
| M14 | Medium | Redis had no password in Compose | `--requirepass`, auth in `REDIS_URL` | compose |
| M15 | Medium | No secret scanning, licence review or image scanning in CI | Secrets stage (tree plus history), licence check, Trivy | CI workflow |
| F4 | Medium | Entity alias add and remove did not check entity visibility; backfill was open to analysts | `assertEntityVisible`; backfill needs `ai:settings` | analysis e2e |
| F6 | Medium | Duplicate lists, `related_count` and emerging-topic labels crossed project boundaries | Visibility filter, same-project scoping | e2e |
| F7 | Medium | An alert-rule owner could be set to a user without project access | `assertOwner` checks project access | alerts e2e |
| L1 | Low | Swagger exposed in production | `API_DOCS_ENABLED` default off in production | config test |
| L2 | Low | `javascript:` URLs from source data rendered as links | `safeHref()` on five pages | web test |
| L3 | Low | SSRF policy missed some IPv6 transition ranges | Blocks `::/96`, `2001::/32`, `64:ff9b:1::/48`, `fec0::/10` | unit tests |
| L4 | Low | AES-GCM auth-tag length not pinned | `authTagLength: 16` | unit test |
| L5 | Low | Session cookie not `__Host-` prefixed | `__Host-cs_session` when secure | auth tests |
| L6 | Low | Oversized or malformed bodies returned 500 | Mapped to 413 and 400 | security e2e |
| L7 | Low | Dashboard period unbounded | ≤ 366 days, `from < to` | e2e |
| L8 | Low | TenantGuard denials were not audited | `authz.denied`, outcome `denied` | security e2e |
| L9 | Low | Restore drill passed a missing migration (non-fatal `diff`) | Missing migration now fails; newer ones are listed | drill output |

### 2.2 Open: accepted risks and remaining work

| ID | Sev. | Item | Why open / mitigation | Acceptance criteria to close |
|---|---|---|---|---|
| O1 | **High** | **No MFA.** The local identity provider does not support it, and none was invented. | Rate limits, strong hashing, idle timeout and session revocation reduce but do not replace MFA. | Integrate an OIDC IdP with MFA enforced for all government users (and mandatory for owners and admins); local passwords disabled in production; tests for IdP login, logout and revocation |
| O2 | **High** | No staging or production environment, managed DB, PITR, encryption-at-rest evidence or deployment agent | Infrastructure work, outside this repository | Staging deployed with DEPLOYMENT.md controls; PITR restore drill recorded with measured RPO and RTO; deploy agent passes a rollback rehearsal |
| O3 | **High** | No independent penetration test or code review | Self-assessment only | External test of web, API and tenant isolation; criticals and highs fixed and retested |
| O4 | **High** | Legal review open: UU PDP basis for processing names of public figures and citizens in news; residency; AI-provider transfer; source licences; breach-notification duties | Product and legal decision | Written counsel opinion; decisions recorded in DATA_GOVERNANCE.md; DPIA completed |
| O5 | Medium | Tenant isolation relies on the app setting `app.tenant_id` per transaction. A code path that runs tenant queries through `withSystem` bypasses the tenant filter by design. | Forced RLS, non-owner role, cross-tenant route matrix and DB tests; `withSystem` is used only by schedulers and sweeps | Static check (lint rule) that request handlers never call `withSystem`; periodic review |
| O6 | Medium | Login is CPU-bound (≈ 100 ms scrypt per attempt; 38 per second saturated 4 cores) | Per-IP and per-account limits | Edge rate limit or WAF on `/api/v1/auth/*` in front of production |
| O7 | Medium | DB pool fixed at 10 per API process | Horizontal scaling | `DB_POOL_MAX` setting; staging load test at target concurrency |
| O8 | Medium | Base images, Actions and Trivy pinned by tag, not digest or SHA; no SBOM or signing | See SUPPLY_CHAIN.md | Digest and SHA pinning via reviewed update PRs; SBOM and cosign in the deploy workflow |
| O9 | Medium | 39 dev-tool advisories (jest, @types/jest, tailwindcss; semver-major fixes) | Not in runtime images | Upgrade PRs with full tests |
| O10 | Medium | No capacity evidence beyond a 4-vCPU single host | See LOAD_TESTING.md limits | Staging load and soak test at the target load |
| O11 | Low | `style-src 'unsafe-inline'` remains (inline style attributes) | Script injection is blocked by the nonce policy | Move to hashed or nonce styles once components allow |
| O12 | Low | Report viewers can read query and topic definitions of reports shared with them (accepted: they define the report's scope) | Documented | — (accepted) |
| O13 | Low | Share-of-voice lists tenant-wide entity names to project-scoped users | Names only, no records | Scope entity list by visible mentions |
| O14 | Low | Analysts can read source `feedUrl` and a credential hint (last 4 characters) | No secret values | Hide from non-admin roles |
| O15 | Low | Migrations pass the app-role password in `ALTER ROLE` (visible if the server logs statements) | Turn off statement logging for the migrate role | Use a pre-hashed `SCRAM-SHA-256` verifier |
| O16 | Low | `migrate` runs as root in the build-stage image | One-shot, no listening port | Dedicated non-root migrate stage |
| O17 | Low | Registration reveals whether an email exists (documented trade-off); reset and login are uniform | Rate limits | Invite-only registration in production (disable open registration) |
| O18 | Low | Web image is about 1 GB (full `node_modules`) | Size and surface | Next.js `output: 'standalone'` |
| O19 | Low | Deleted data remains in backups until they expire; files already downloaded are outside system control | Documented to requesters (DATA_GOVERNANCE.md) | Backup lifecycle aligned with retention; re-apply deletions after restore (procedure exists) |

### Blocking before production
O1, O2, O3 and O4 must close. O5, O6, O8 and O10 should close before handling real citizen data at scale.

## 3. Gap analysis by area

| Area | State | Gaps that remain |
|---|---|---|
| Security | Controls in SECURITY.md implemented and tested (tenant isolation, authz matrix, CSRF origin check, CSP, SSRF policy, encryption of stored secrets, redaction) | O1, O3, O5, O6, O11 |
| Data governance | Retention enforcement, legal hold, four-eyes deletion, audit hash chain; minimal-field ingestion | O4 legal basis; backup lifecycle (O19) |
| Operations | Health, readiness, metrics, structured logs, runbook, alert suggestions | No real alerting stack connected; no on-call rota |
| Dependencies | Lockfile, prod audit clean, licence screen, image scan | O8, O9 |
| Recovery | Verified local drill; CI drill; DR and IR procedures | O2 (PITR, encrypted backups, measured RTO) |
| Test coverage | 469 API tests in 27 suites (unit, migration invariants, RLS, security, e2e per milestone) and 12 web tests | No browser end-to-end suite; no fuzzing; load test is local only |

## 4. Remediation tasks and acceptance criteria (next milestone)

1. **IdP and MFA (O1).** OIDC provider adapter behind the existing `IdentityProvider` port.
   *Done when:* MFA is enforced by the IdP; owners and admins cannot log in without it; local login is disabled with `APP_ENV=production`; e2e covers callback, state and nonce, logout and revocation.
2. **Staging (O2).** Provision per DEPLOYMENT.md: managed PostgreSQL with PITR and CMK, Redis with AUTH and TLS, LB with TLS and WAF, egress proxy, deploy agent, secret manager.
   *Done when:* `civicsignal-deploy` deploys a SHA to staging; readiness passes; a rollback rehearsal and a PITR drill are recorded with measured times.
3. **External test (O3).** *Done when:* the report is received, and findings are triaged, fixed and retested.
4. **Legal (O4).** *Done when:* counsel's opinion is filed; DATA_GOVERNANCE.md open items are resolved; DPIA is signed.
5. **Hardening backlog:**
   - O5 lint rule;
   - O6 edge limit;
   - O7 pool setting;
   - O8 pinning, SBOM and signing;
   - O13, O14 and O17.

   Each has the acceptance criterion in the table above.

## Evidence
- Commits on branch `claude/youthful-darwin-rk5mhl`: `5d67981`, `b20d5a7`, `b01719b`, `6bf7a0f`, `afc9aee` and the documentation commit that adds this file.
- **Tests (2026-10-20):**
  - Final full run after all changes: lint and typecheck clean; API 27 suites, **469 passed, 0 failed** (the paging check was added to an existing test); web 12 passed; API and web build.
- **Scans (2026-10-20):**
  - secret scan: 0 findings (tree plus history);
  - `npm audit --omit=dev`: 0;
  - licences: 201 packages pass;
  - Trivy: 0 fixable HIGH/CRITICAL in api and web images.
- **Drills:** BACKUP_AND_RECOVERY.md verification record. **Load:** LOAD_TESTING.md.
