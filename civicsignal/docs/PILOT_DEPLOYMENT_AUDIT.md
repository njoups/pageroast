# Pilot Deployment Audit (Prompt 10)

Date: 2026-10-21. Scope: the `civicsignal/` monorepo on branch `claude/youthful-darwin-rk5mhl`, plus this development container.
Every statement below was checked against the repository or a command run in this container. **No staging or production environment exists, and nothing was deployed.** No domain, DNS, cloud account, registry credential, SMTP relay, AI key or payment provider was available or used.

Companion documents:
- [DEPLOYMENT.md](DEPLOYMENT.md): environments, staging, production design, domain/TLS, secrets, release and rollback.
- [DISASTER_RECOVERY_RUNBOOK.md](DISASTER_RECOVERY_RUNBOOK.md)
- [INCIDENT_RESPONSE_RUNBOOK.md](INCIDENT_RESPONSE_RUNBOOK.md)
- [PILOT_OPERATIONS_RUNBOOK.md](PILOT_OPERATIONS_RUNBOOK.md)

---

## 1. Current state (verified)

| Area | Finding | Evidence |
|---|---|---|
| Runtime | Node.js 22 (images: `node:22-bookworm-slim`, now pinned by digest) | `apps/*/Dockerfile` |
| Backend | NestJS 11.2 API (`apps/api/dist/main.js`) and a separate worker process (`dist/worker.js`) with 8 schedulers and 4 BullMQ queues | `src/worker.ts` |
| Frontend | Next.js 16.4 / React 19.3. Server-rendered and runs `next start`, not the dev server. It proxies only `/api/v1/*` to the API (same origin) | `apps/web/next.config.mjs` |
| Database | PostgreSQL 16, 14 forward-only checksummed migrations, forced RLS on every tenant table, restricted app role `civicsignal_app` plus owner role for migrations | `db/migrations`, `src/database/migrate.ts` |
| Queue | Redis 7 + BullMQ 6.3. Required by the worker; the API degrades (collection endpoints return 503) without it | `src/config.ts` |
| Authentication | Local identity provider: scrypt passwords, opaque DB sessions, `__Host-cs_session` cookie, idle and absolute expiry. **No SSO, no MFA, no email verification** | `src/identity`, QA report AZ-05 |
| AI | Anthropic adapter (optional, key in env) or a rule-based baseline (default, no network). Never verified against the live API | `src/analysis/providers` |
| Data sources | RSS/Atom feeds and GDELT through an SSRF-safe fetcher. YouTube Data API connector (key stored encrypted per connector), mock-tested only | `src/ingestion`, `src/social` |
| Object storage | **None.** Report files are stored in PostgreSQL (`report_artifacts.data`, bytea) and expire after `REPORT_ARTIFACT_TTL_DAYS` (30). No uploads exist | migration 0009 |
| Email / notifications | SMTP (nodemailer) for alerts, reports, password reset and usage notices. Optional WhatsApp Cloud API. Signed customer webhooks | `src/alerts/channels` |
| Payments | No live provider. `none` (contracts, manual invoices) or `test` (HMAC simulator) | `src/commercial/billing-provider.ts` |
| Configuration | 80 environment variables read in `src/config.ts` and validated at startup (now including staging and production requirements) | `src/config.ts`, `test/unit/security.spec.ts` |
| Containers | Multi-stage Dockerfiles: non-root `node` user, no npm in the runtime image, health checks. Dev compose (`docker-compose.yml`) with a Caddy edge | repository |
| CI | `civicsignal-ci`: secret scan (tree and history); then lint, typecheck, all tests, build, `npm audit`, licences and a restore drill; then a Trivy scan of the images | `.github/workflows/civicsignal-ci.yml` |
| CD | `civicsignal-deploy`: manual dispatch only, gated by CI, approval-gated GitHub environments, images pushed by digest to GHCR, handed to an operator-run deployment agent. **No agent or environment exists** | `.github/workflows/civicsignal-deploy.yml` |
| Hosting | **None chosen or provisioned.** | — |
| Tests (start of Prompt 10) | 34 API suites / 577 tests, web 20/20, lint, typecheck and build green. CI runs #20 and #21 green | FULL_SYSTEM_QA_REPORT.md |
| Known QA blockers | 10 open P2s (AI-06, AI-07, AI-10, AI-11, AI-12, IN-04, AR-04, AR-06, AR-08, FE-02). External services never verified live | FULL_SYSTEM_QA_REPORT.md §11 |

## 2. Deployment gaps found and what was done

| # | Gap | Severity | Status |
|---|---|---|---|
| D-01 | **No `main` branch exists on the remote.** The default branch (`claude/sweet-ptolemy-hcl2ce`) holds only an SEO report. CivicSignal exists only on this feature branch, so the production gate ("commit must be on main") could never pass, and nothing is reviewed and merged | Blocker for production | **Open (owner action):** create and protect a release branch (branch protection, required reviews, required CI). The gate now reads the repository variable `RELEASE_BRANCH` (default `main`) and fails with a clear message if the branch is missing |
| D-02 | **The repository is public.** It contains the full security design and runbooks. No secrets are committed (scan: 0 findings) | High | **Open (owner action):** make it private (Settings → General → Danger Zone) |
| D-03 | The deploy workflow's readiness check polled `$PUBLIC_BASE_URL/health/ready`, which the public edge never routes (the web app only proxies `/api/v1/*`), so every deployment would have failed its check | High | Fixed: new `/readyz` (web → API → DB, Redis, migrations; returns only ok/unavailable) and `/healthz` (web liveness) routes. The workflow uses `/readyz` |
| D-04 | **The restore drill reset the live database's application role password.** `verify-restore.sh` passed a random `APP_DB_PASSWORD` into the restore, and `civicsignal_app` is a cluster-wide role. Running the documented drill on a server that also hosts production would lock the application out. Found by running the drill against the containerized stack: `/health/ready` went to 503 | High | Fixed: the drill removes `APP_DB_PASSWORD` from the restore. `restore.sh` documents the risk. Verified: the live API stays ready after the drill, including after a restart that forces new connections |
| D-05 | Restoring an **encrypted** backup failed: `gpg` refused to overwrite the temp file without `--yes`. The encrypted path had never been exercised | High | Fixed and verified (encrypted backup → restore drill passes) |
| D-06 | Staging could not be configured safely: `NODE_ENV=production` refused the billing simulator, and nothing prevented staging from emailing or calling real customers | High | Fixed: `APP_ENV=staging` allows `BILLING_PROVIDER=test` and requires `NOTIFY_ALLOWED_EMAIL_DOMAINS`. Webhooks and WhatsApp are denied in staging unless their hosts or numbers are listed. Enforced in each channel before any network call (tests) |
| D-07 | Deployed environments could start without `CREDENTIALS_KEY`, `METRICS_TOKEN` or SMTP (connector credentials, monitoring and password reset silently unavailable). A mistyped number (`"30s"`) became `NaN` and silently disabled a limit. Production could enable the API docs | Medium | Fixed: startup refuses each case with a clear message (tests) |
| D-08 | No production deployment definition: only the dev compose existed (local Postgres, builds from source, no TLS) | High | Added `infra/compose.production.yml` and `infra/Caddyfile.production`. Images run by digest, the one-shot migrate job, a TLS edge with HSTS, internal networks, read-only non-root containers with no capabilities, resource limits, log rotation, and an optional self-hosted data profile |
| D-09 | No environment templates for staging and production | Medium | Added `infra/env/{staging,production,migrate}.env.example` (names and placeholders only) |
| D-10 | Base images were floating tags; the web image had no health check | Medium | Base images pinned by digest; web `HEALTHCHECK` on `/healthz`; `STOPSIGNAL`, OCI revision label |
| D-11 | No post-deployment smoke test | High | Added `scripts/smoke.mjs`: read-only, no messages, no quota. The deploy workflow runs it after readiness |
| D-12 | Production could be deployed without the same commit having passed staging | Medium | The production gate now requires a successful staging deployment of the same SHA |
| D-13 | Nothing in CI stopped an edited applied migration or a destructive new one | Medium | Added `scripts/check-migrations.mjs` and `db/migrations.lock` (checksums, expand/contract rules); runs in CI |
| D-14 | The production deployment files had never been tested together | High | Added `scripts/stack-test.sh` (CI job `stack`): migrate, health, TLS edge, hardening, HTTPS smoke, encrypted backup and restore drill, graceful shutdown, log hygiene |
| D-15 | No database pool, ingestion, billing-webhook, social-quota or backup metrics; no alert rules | Medium | New gauges in `/metrics`, a backup textfile metric, and `infra/monitoring/alerts.yml` (23 rules, `promtool` valid) |
| D-16 | DB pool size fixed at 10 in code | Low | `DATABASE_POOL_MAX` (1–100) |

## 3. Environments

| | Local development | Automated testing | Staging | Production |
|---|---|---|---|---|
| Where | Developer machine, `docker-compose.yml` or `npm run dev` | GitHub Actions (`civicsignal-ci`) and local `npx jest` | Operator infrastructure (none yet) | Operator infrastructure (none yet) |
| `APP_ENV` / `NODE_ENV` | `local` / development (Compose: production) | `local` / test | `staging` / production | `production` / production |
| Database | Local Postgres 16 | Disposable databases created and dropped per run; service containers in CI | Its own instance (managed preferred) | Its own managed instance, PITR |
| Redis | Local | Database 15 of a disposable Redis | Its own | Its own (managed, AUTH + TLS) |
| Secrets | `.env` (gitignored) with values the developer generates | Generated per run; synthetic | Staging secret manager scope | Production secret manager scope; separate custodians |
| Data | Synthetic only | Synthetic fixtures only (no customer data) | Synthetic or approved test data, never production copies | Customer data |
| Outbound messages | Dev SMTP sink or none | Local SMTP sink | **Allow-listed recipients only** (enforced) | Customers' own recipients |
| Billing | `none` or `test` | `test` | `test` simulator only | `none` (contracts and manual invoices); no live provider exists |
| AI | baseline | `test` fixtures / baseline | baseline, or a staging key with a low per-tenant token limit | baseline or production key |
| Deploy | manual | n/a | `civicsignal-deploy` → staging (approval) | same SHA, after staging, approval with self-review prevented |
| Logs / monitoring | console | CI logs | JSON logs + Prometheus (staging labels) | JSON logs + Prometheus + paging |

Configuration reference (required, optional and environment-specific): [DEPLOYMENT.md § Configuration](DEPLOYMENT.md#configuration).

## 4. External services

| Service | Purpose | Credentials / permissions | Limits and cost | Failure behaviour (implemented) | Timeout / retry | Monitoring | Data obligations | Readiness |
|---|---|---|---|---|---|---|---|---|
| PostgreSQL 16 | System of record | Owner role (migrate job only); `civicsignal_app` (no BYPASSRLS, owns nothing) | Instance size, storage, backups (provider pricing not verified) | `/health/ready` 503; requests fail with 5xx; no silent fallback | `statement_timeout` 15 s; pool `DATABASE_POOL_MAX` | pool, size, readiness alerts | Customer data: residency and retention per contract | Local only; **managed instance not provisioned** |
| Redis 7 | BullMQ queues, rate limits, heartbeats | Password (AUTH), TLS when managed | Memory size; `noeviction` required | Worker stops processing; API collection endpoints return 503; readiness fails | ioredis defaults | queue lag, worker heartbeat | Job payloads hold ids, not content | Local only |
| SMTP relay (any provider) | Alerts, reports, password reset, usage notices | SMTP credentials in `SMTP_URL` | Provider sending limits and pricing (not verified) | Delivery `failed` (retried) or `dead` (5xx); recorded as `unconfigured` without SMTP; never reported as sent | 5 attempts, 30 s backoff base; 60/min per tenant | notification failure alerts | Recipient addresses; message content | **Never tested against a real relay**; SPF/DKIM/DMARC to configure |
| Anthropic API | Article analysis, summaries, report commentary | `ANTHROPIC_API_KEY` (server only) | Token pricing in `ai_pricing` (configuration; current list prices **not verified**); per-tenant monthly token limit (default 2 M) | Falls back to the baseline analyser and labels results `partial` (`AI_FALLBACK=baseline`), or fails visibly (`none`); refusals and truncation metered | 60 s timeout; 4 attempts; 20 s backoff; 30 requests/min; concurrency 2 | analysis failures, quota exhaustion | Sends permitted article text only; provider retention per their terms (legal review open) | **Never called live** |
| YouTube Data API v3 | Social listening (public videos/comments) | API key per connector (encrypted with `CREDENTIALS_KEY`) | Provider daily quota units, Pacific-time reset; budgets per connector | Pauses at budget or quota; resumes next provider day; no fake data | per-call timeout via safe fetcher; budget-aware | social quota alert | Provider storage limits; refresh-or-delete job | **Mock provider only** |
| RSS/Atom publishers, GDELT | News collection | None (public feeds); per-source authorization basis required | Polite host spacing (GDELT 6 s) | Run fails and retries; source marked; no substitute data | 30 s timeout, 5 attempts, 30 s backoff, 5 MB cap | ingestion overdue / failing alerts | Licence registry per source (legal review open) | Verified live on a few public feeds (Prompt 02) |
| WhatsApp Cloud API (optional) | Alert notifications | Access token, phone number id, approved template | Meta pricing (not verified) | Delivery failed/dead; unconfigured without token | 15 s timeout; alert retry policy | notification failures | Phone numbers | Mock-tested only |
| Customer webhook receivers | Alert delivery to customer systems | HMAC signing secrets per endpoint | — | Retries, then `dead`; redirects not followed | 10 s timeout; 5 attempts | webhook failure alert | Issue summaries leave the platform | Local receiver only |
| Payment provider | Self-service subscriptions | — | — | **Not implemented** (contracts and manual invoices only) | — | billing webhook failures (simulator) | — | Not implemented |
| Container registry (GHCR) | Image storage by digest | `GITHUB_TOKEN` packages:write in the deploy workflow | GitHub plan limits | Deploy fails before anything changes | — | — | Images contain no secrets | Workflow written; **never run** |
| TLS certificates (ACME via Caddy, or load-balancer managed) | HTTPS | DNS control, ports 80/443 | Free (Let's Encrypt) or provider | Caddy keeps the last valid certificate; expiry alert at 14 days | automatic renewal | certificate expiry alert | — | Verified only with Caddy's internal CA on `localhost` |

## 5. Data protection and government-customer readiness

| Control | Status | Verification |
|---|---|---|
| Tenant isolation (forced RLS, guards, cross-tenant matrix) | Implemented | Automated tests (every run). An independent penetration test has not been done |
| Report and export authorization (`data:export`, report_viewer cannot export) | Implemented | Regression test (QA AZ-02) |
| Retention policies, legal hold, four-eyes deletion | Implemented | Integration tests. Not exercised on production-sized data |
| Backups protected (encryption, checksums, restricted ACL) | Implemented in scripts (GPG, sha256, manifest). Storage location and ACL are operator decisions | Encrypted backup and restore drill passed on 2026-10-21 (local stack) |
| Audit events retained and tamper-evident (hash chain) | Implemented | Chains verified after restore in the drill |
| Secrets and personal data not logged | Implemented (redaction) | Stack test: no generated secret in any container log. Unit tests for redaction |
| Providers used only for authorized purposes | Documented (DATA_GOVERNANCE.md); enforced by source authorization basis and the AI data-flow rules | Legal review of licences and the AI provider's terms **open** |
| Production access limited to authorized operators | Designed (no SSH, bastion, approval-gated deploys) | **Not verifiable**: no production environment exists |
| MFA for users and operators | **Not implemented** in the application; must come from an external IdP | — |
| Certifications (ISO 27001, SOC 2, BSSN/SPBE, UU PDP compliance) | **None claimed.** This system has not been assessed against any standard | — |

## 6. Cost model (assumptions, not quotes)

No provider prices were verified in this session. Every figure must be filled in from current price lists at purchase time. The structure and drivers below come from the code and the load test.

| Cost driver | Unit that drives it | Where to get the number | Safeguard in the product |
|---|---|---|---|
| Application hosting (API ×1–2, worker ×1, web ×1–2, edge) | vCPU/RAM-hours. Load test: one 4-vCPU host served the 60k-record synthetic workload at p95 < 0.45 s | Provider calculator | Resource limits in `compose.production.yml` |
| PostgreSQL | Instance size, storage GB, backup storage, PITR retention | Provider calculator | `civicsignal_database_bytes`, disk alert |
| Redis | Memory size | Provider calculator | queue lag alert |
| Report storage | Bytes in PostgreSQL (`civicsignal_report_artifact_bytes`); 30-day expiry | — | `REPORT_ARTIFACT_TTL_DAYS`, `REPORT_RUNS_PER_DAY` |
| Bandwidth | Feed downloads (≤ 5 MB per response), page views | Provider calculator | response size cap, host spacing |
| LLM | Tokens per analysed article × articles/month × price per MTok (input, cache read/write, output) | Anthropic price list on the purchase date; enter in `ai_pricing` | Per-tenant monthly token limit, 30 requests/min, baseline fallback; cost per record visible in the platform console |
| Licensed media data | Per-source contracts | Publishers | Source authorization registry |
| Social APIs | YouTube quota units (daily quota assigned by the provider) | Google Cloud console (quota page) | Per-connector budgets, provider-quota pause |
| Email / WhatsApp | Messages per month | Provider price list | Per-tenant per-minute and daily notification limits |
| Monitoring and logging | Metrics series, log GB/day (JSON access logs, 10 MB × 5 rotation per container on the host) | Provider calculator | Log rotation |
| Backups | Dump size (`civicsignal_backup_last_size_bytes`) × retention | Storage price list | Retention policy in DISASTER_RECOVERY_RUNBOOK.md |

Plan quotas, entitlements and usage metering per tenant already exist (Prompt 08). The platform console shows usage and AI cost per tenant. Scaling triggers and the capacity-test procedure: [DEPLOYMENT.md § Capacity](DEPLOYMENT.md#capacity-and-scaling).

## 7. Verification performed in this session

All commands ran in this development container (4 vCPU, Docker 29.8 with Compose v5.6). The exact results are below.

| Command | Result |
|---|---|
| `npm run lint` | exit 0 |
| `npm run typecheck` | exit 0 |
| `cd apps/api && TEST_ADMIN_DATABASE_URL=… TEST_REDIS_URL=… npx jest` | **34 suites, 590 tests passed** (577 before; +13 for configuration, allow-lists and metrics) |
| `cd apps/web && npm test` | 20/20 passed |
| `npm run build` | exit 0 |
| `node scripts/scan-secrets.mjs --history` | 326 files, 0 findings (31 allow-listed test fixtures) |
| `node scripts/check-licenses.mjs` | exit 0 |
| `npm audit --omit=dev --audit-level=high` | 0 vulnerabilities |
| `node scripts/check-migrations.mjs` | 14 files, 14 locked, 0 new. A negative test (an edited locked migration, plus an unjustified DROP COLUMN and UPDATE without WHERE) was refused, and the lock step refused to proceed |
| `shellcheck -S warning` (stack-test, backup, restore, verify-restore) | clean (one finding fixed) |
| `hadolint --failure-threshold warning` (both Dockerfiles) | clean (exec-form HEALTHCHECK and numeric USER fixed) |
| `promtool check rules infra/monitoring/alerts.yml` / `check config prometheus.example.yml` | 23 rules valid; config valid |
| `caddy validate` (Caddyfile.production) | Valid configuration |
| `docker compose -f infra/compose.production.yml config` and `docker-compose.yml config` | valid |
| `API_IMAGE=… WEB_IMAGE=… scripts/stack-test.sh` | **passed** (see below) |

The stack test ran on the production Compose stack in staging mode with self-hosted data:
- the migrate job applied 14 migrations from the read-only runtime image;
- all services became healthy;
- api, worker and web run as uid 1000 with a read-only root filesystem, no capabilities and `no-new-privileges`; only the edge publishes ports;
- the HTTPS smoke test passed 18/18 (security headers, HSTS, HTTP→HTTPS, internal paths 404, CSRF refusal, `__Host-` session cookie, signed-in reads, logout);
- `/metrics` refused without the token;
- the platform-admin bootstrap command worked through the migrate job;
- an encrypted backup restored and verified (rows, RLS, privileges, audit chains), and the live API stayed healthy afterwards;
- the worker drained and exited 0 on SIGTERM;
- no generated secret appeared in any container log.

A manual run also showed that a missing `NOTIFY_ALLOWED_EMAIL_DOMAINS` stops the staging API at startup with a message naming the variable.

**Limitations of this verification:**
- **The real Dockerfiles were not built in this container.** The sandbox's build containers have no route to the npm registry, and routing them through the session's egress proxy was refused by the environment's policy.
  - The runtime was tested with images assembled offline from host-built artifacts on the same pinned base image, with the same user, health checks and entrypoints.
  - The real Dockerfiles are built, Trivy-scanned and stack-tested by CI (`containers` and `stack` jobs). Their first run on these changes happens on the push that carries this report: see CI.
- TLS was verified only with Caddy's internal CA for `localhost`. No public certificate, DNS record or domain was involved.
- No staging or production environment, registry push, deployment agent, managed database, PITR, real SMTP, AI key or monitoring stack was available. None of these was exercised.
- Load and capacity numbers are from the synthetic local load test (FULL_SYSTEM_QA_REPORT.md §9), not from production-like infrastructure.

## 8. What remains (owner and operator actions)

| # | Action | Who | Blocks |
|---|---|---|---|
| 1 | Create and protect the release branch (`main`, or set `RELEASE_BRANCH`). Merge this branch through a reviewed PR | Repository owner | Any production deployment |
| 2 | Make the repository private | Repository owner | Pilot |
| 3 | Choose hosting (DEPLOYMENT.md § Production design) and region (data residency to be confirmed with counsel). Provision staging and production separately | Owner / operator | Staging |
| 4 | Create GitHub environments `staging` and `production`: required reviewers, prevent self-review, secrets `DEPLOY_HOOK_URL`, `DEPLOY_HOOK_TOKEN`, `SMOKE_EMAIL`, `SMOKE_PASSWORD`; variable `PUBLIC_BASE_URL` | Owner | Any deployment |
| 5 | Run the deployment agent in each environment (contract in DEPLOYMENT.md) | Operator | Any deployment |
| 6 | Domain, DNS records, TLS (checklist in DEPLOYMENT.md) | Domain owner | Staging |
| 7 | SMTP relay with SPF, DKIM and DMARC; staging allow-list | Operator | Password reset, alerts |
| 8 | Secret manager entries for every required variable, with named custodians | Operator | Staging |
| 9 | Monitoring stack (Prometheus + Alertmanager + blackbox + node exporter, or the provider's equivalent) with paging | Operator | Pilot |
| 10 | Backups: managed PITR plus the nightly encrypted logical backup off-host; first restore drill on staging | Operator | Pilot |
| 11 | Fix the open P2s that affect customer-visible numbers (AR-04, AR-06, AR-08, IN-04) | Engineering | Pilot |
| 12 | Live verification on staging: real SMTP, AI key with a small budget, one real feed set | Engineering + operator | Pilot |
