# Deployment

> **Status (2026-10-21): no staging or production environment exists, and nothing has been deployed.** This document is the
> design and procedure for creating them. What was verified locally is listed in
> [PILOT_DEPLOYMENT_AUDIT.md § 7](PILOT_DEPLOYMENT_AUDIT.md#7-verification-performed-in-this-session).
> No hosting provider, region or network has been chosen.
> Nothing here is a certification or a claim of compliance with any government security standard (BSSN guidance, SPBE, a customer's own policy).
> Legal requirements (UU PDP, data residency, sector rules) must be confirmed with qualified Indonesian professionals.

Contents:
1. [Environments](#environments)
2. [Configuration](#configuration)
3. [Staging and single-host pilot procedure](#staging-and-single-host-pilot-procedure)
4. [Smoke-test checklist](#smoke-test-checklist)
5. [Production design](#production-design)
6. [Domain, TLS and network checklist](#domain-tls-and-network-checklist)
7. [Secrets and configuration management](#secrets-and-configuration-management)
8. [Release process](#release-process)
9. [Database migrations](#database-migrations)
10. [Rollback](#rollback)
11. [Observability](#observability)
12. [Capacity and scaling](#capacity-and-scaling)
13. [Local stack (Compose)](#local-stack-compose)

## Environments

There are four environments: local development, automated testing, staging and production. Each has its own database, Redis, secrets and logging; nothing is shared between staging and production. The full comparison is in [PILOT_DEPLOYMENT_AUDIT.md § 3](PILOT_DEPLOYMENT_AUDIT.md#3-environments).

- **Staging** runs with `APP_ENV=staging` and `NODE_ENV=production`. It has the same hardening as production, plus:
  - outbound email only to `NOTIFY_ALLOWED_EMAIL_DOMAINS`;
  - webhooks and WhatsApp only to listed hosts and numbers;
  - the billing simulator instead of real payments.
- **Production** refuses every test-only switch.

## Configuration

Templates: `infra/env/production.env.example`, `infra/env/staging.env.example`, `infra/env/migrate.env.example`, `.env.example` (local). They contain variable names and placeholders only.

The API and worker validate configuration at startup (`apps/api/src/config.ts`). They **refuse to start** with a message naming the variable, and never print its value.

| Variable | Local | Staging | Production | Notes |
|---|---|---|---|---|
| `APP_ENV` | `local` | `staging` | `production` | Selects the checks below |
| `DATABASE_URL` | required | required | required | Restricted `civicsignal_app` role only |
| `MIGRATION_DATABASE_URL`, `APP_DB_PASSWORD` | migrate only | migrate job only | migrate job only | Owner role; refused if equal to `DATABASE_URL` |
| `REDIS_URL` | optional (API) / required (worker) | required | required | `rediss://` for managed Redis |
| `APP_ORIGINS`, `APP_BASE_URL` | http allowed | **https** required | **https** required | Exact public origin |
| `TRUST_PROXY` | false | **true** required | **true** required | Only behind the edge that rewrites `X-Forwarded-For` |
| `COOKIE_SECURE` | true | true (enforced) | true (enforced) | |
| `CREDENTIALS_KEY` | optional | **required** | **required** | 32 bytes base64; losing it makes stored connector credentials unreadable |
| `METRICS_TOKEN` | optional | **required** (≥ 32 chars) | **required** (≥ 32 chars) | Monitoring bearer token |
| `SMTP_URL`, `EMAIL_FROM` | optional | **required** | **required** | Password reset, alerts, reports |
| `NOTIFY_ALLOWED_EMAIL_DOMAINS` | — | **required** | unset | Domains or full addresses |
| `NOTIFY_ALLOWED_WEBHOOK_HOSTS`, `NOTIFY_ALLOWED_PHONE_NUMBERS` | — | deny-all unless set | unset | |
| `BILLING_PROVIDER` | `none`/`test` | `test` allowed | `none` only (`test` refused) | No live provider adapter exists |
| `AI_PROVIDER`, `ANTHROPIC_API_KEY` | baseline | baseline or a staging key | baseline or the production key | `test` refused in staging and production |
| `API_DOCS_ENABLED` | default on | optional | `true` refused | |
| `DATABASE_POOL_MAX` | 10 | 10 | 10 (1–100) | Per process |
| `RATE_LIMIT_ENABLED=false`, `INGESTION_ALLOW_PRIVATE_HOSTS`, `ALERTS_WEBHOOK_ALLOW_HTTP`, `YOUTUBE_API_BASE_URL` | tests only | refused | refused | |
| Every numeric setting | — | — | — | A value that is not a number (e.g. `30s`) is refused |

All other settings (limits, schedules, TTLs) are optional, with defaults documented in `.env.example` and `src/config.ts`.

## Staging and single-host pilot procedure

`infra/compose.production.yml` runs one environment on one Docker host:

- images are pulled **by digest**;
- a one-shot `migrate` job applies migrations;
- `api`, `worker` and `web` run on a read-only root filesystem, as a non-root user, with all capabilities dropped, `no-new-privileges` and resource limits;
- a Caddy edge provides TLS with automatic certificates, HSTS, security headers and a 2 MB body limit, and refuses internal paths;
- the `app` and `data` networks are internal (no internet access);
- PostgreSQL and Redis are external managed services by default. The `selfhosted-data` profile runs them on the host for a pilot.

The whole file set is exercised by `scripts/stack-test.sh` (CI job `stack`).

**One-time host preparation (operator):**
1. Provision a Linux VM:
   - Docker Engine with Compose v2;
   - firewall inbound only on 80/443 (plus your admin path: bastion or session manager, never public SSH);
   - automatic security updates.
2. Create DNS `A`/`AAAA` records for the environment's hostname pointing at the VM. See the [domain checklist](#domain-tls-and-network-checklist).
3. Write the env files from the secret manager to `/etc/civicsignal/` (mode 0600, owner root):
   - `app.env` (from `infra/env/staging.env.example` or `production.env.example`);
   - `migrate.env`;
   - with `selfhosted-data`: `postgres_password` and `redis_password`.
4. Check out the repository at the release commit (only `infra/` is used on the host), and authenticate Docker to the registry with a **read-only** pull token.

**Each release (what the deployment agent automates):**
```bash
export API_IMAGE=ghcr.io/<owner>/civicsignal-api@sha256:<digest>   # from the civicsignal-deploy run summary
export WEB_IMAGE=ghcr.io/<owner>/civicsignal-web@sha256:<digest>
export PUBLIC_DOMAIN=staging.<your-domain> ACME_EMAIL=ops@<your-domain>
C="docker compose -f infra/compose.production.yml"          # add --profile selfhosted-data for the pilot data services
$C pull
$C --profile migrate run --rm migrate                         # stop here if it fails: nothing else has changed
$C up -d --wait api worker web edge                          # health-checked; previous containers keep serving until replaced
BASE_URL=https://staging.<your-domain> node scripts/smoke.mjs # plus SMOKE_EMAIL/SMOKE_PASSWORD for signed-in checks
```

**First start of a new environment:**
1. Run the migrate job; it creates the schema and sets the application role's password.
2. Register the operator's account in the web app, then grant it platform-administrator rights with the owner credentials (the migrate service holds them):
   `$C --profile migrate run --rm migrate node apps/api/dist/database/promote-platform-admin-cli.js <email>`.
   The grant is audited (COMMERCIAL_OPERATIONS_RUNBOOK.md).
3. Create the internal smoke-test organization and account. Store their credentials as the environment's `SMOKE_EMAIL` / `SMOKE_PASSWORD` secrets.

**Single-host limitations:** see [Production design](#production-design). One host is a single point of failure. Use it for staging and, if the customer accepts the stated availability, for a limited pilot. **It is not high availability.**

## Smoke-test checklist

**Automated** (`scripts/smoke.mjs`; read-only; no messages, no AI or provider quota):

| Check | Expectation |
|---|---|
| `/healthz` | Web process alive |
| `/readyz` | Web → API → database, Redis and migrations ready; only `{"status":"ok"}` is exposed |
| `/login` | CSP with nonce, `X-Frame-Options: DENY`, `nosniff`, HSTS ≥ 1 year, no `X-Powered-By` |
| `http://` | Redirects to `https://` |
| `/metrics`, `/health/*`, `/api/docs`, `/api-json` | 404 at the edge |
| `/api/v1/auth/me` without a session | 401 with the error envelope |
| Foreign `Origin` on a POST | 403 (CSRF origin check) |
| Smoke account sign-in | `__Host-` cookie, Secure, HttpOnly, SameSite |
| Signed in | Projects, analytics overview, mention search, alert rules and billing all answer 200 |
| Logout | The session is invalid afterwards |

**Manual, staging only** (these create records; use the internal smoke organization):
1. **Ingestion:** add an authorized test feed and trigger collection. Mentions appear and the run is `succeeded`.
2. **AI:** analyse 5 records. With a staging key, check the cost in the platform console and that the tenant's token limit is low. With the baseline, results are labelled `baseline`.
3. **Alerts:** create a keyword rule, then "test send" to an allow-listed address. Also send to a non-listed address and confirm the delivery is marked failed with the allow-list reason.
4. **Reports:** generate a weekly report; PDF and CSV download (owner) and CSV refused for report_viewer.
5. **Billing:** send a signed simulator event with `scripts/billing-test-event.mjs`. The subscription changes and the event is `processed`. Confirm no real payment provider is configured.
6. **Usage:** usage counters moved for the actions above (billing page).
7. **Monitoring:** `/metrics` scraped and the alert rules loaded. Stop the worker for 6 minutes on staging and confirm `CivicSignalNoWorkers` pages.
8. **Backup:** run the backup and the restore drill (DISASTER_RECOVERY_RUNBOOK.md) against staging.

## Production design

**Workload facts** (FULL_SYSTEM_QA_REPORT.md §9, LOAD_TESTING.md):
- one 4-vCPU host served 60k synthetic records at p95 under 0.45 s up to 32 concurrent requests;
- login is CPU-bound (scrypt);
- the database pool (10 per process) is the first concurrency limit.

A pilot is a handful of organizations with tens of users. This does **not** need orchestration (Kubernetes): containers on managed compute, a managed database and a managed Redis are enough.

| Option | What it is | For | Limits |
|---|---|---|---|
| **A. Single host** (`compose.production.yml` + `selfhosted-data`) | One VM runs everything | Staging; a small pilot whose customer accepts the availability | Single point of failure: host, disk or zone loss is an outage. Restore time depends on off-host backups (RTO hours). The operator owns database patching |
| **B. Recommended for pilot and production:** managed PostgreSQL + managed Redis + containers on 2 hosts or a managed container service behind a load balancer | Same images. `DATABASE_URL`/`REDIS_URL` point to the managed services; `selfhosted-data` is not used | Production and government pilots | Needs a provider with an Indonesian region if residency is required (to confirm with counsel). Higher cost than A |
| C. Kubernetes | Orchestrated containers | Only when there are many tenants or teams, or several services to scale independently | Operational complexity not justified by current requirements |

**Recommended production layout (option B):**
```
Internet ──TLS──> [load balancer / WAF]  (TLS 1.2+, managed cert, HSTS, edge rate limit on /api/v1/auth/*)
                        │
          [edge (Caddy) + web ×2 + api ×2]  (private subnet, no public IPs; or one compose host per zone)
                        │
     [worker ×1 (schedulers) + worker ×n --no-scheduler]
                        │
     [managed PostgreSQL 16: private endpoint, TLS verify-full, PITR, multi-AZ]   [managed Redis: AUTH + TLS, noeviction]
egress: NAT/egress proxy (443, 587/465 only) ──> feeds, AI provider, SMTP, webhook receivers
```

| Concern | Design |
|---|---|
| Application hosting | The two images (`civicsignal-api`, `civicsignal-web`), run by digest. API and web at 2 replicas each for zone redundancy. Rolling updates with health checks |
| Database | Managed PostgreSQL 16. Private endpoint, `sslmode=verify-full`, PITR on, multi-AZ for production. Owner credentials only in the migrate job |
| Queue and workers | Managed Redis with `maxmemory-policy noeviction`. **Exactly one** worker runs the schedulers; extra workers start with `--no-scheduler` |
| Scheduled jobs | Built into the worker: collection, alerts, analytics, reports, retention, social lifecycle and commercial ticks. No external cron. Logical backups run from the operator's backup host or job (DISASTER_RECOVERY_RUNBOOK.md) |
| Object storage | Not required today: report files live in PostgreSQL and expire after 30 days. If report volume grows, move them to private object storage (no public access, server-side encryption). That needs a code change |
| DNS and TLS | Managed certificate at the LB (option B) or Caddy ACME (option A). See the checklist below |
| Secrets | Provider secret manager, injected as env files or env vars at start. See [Secrets](#secrets-and-configuration-management) |
| Network boundaries | Only the LB or edge is public. The database and Redis accept only the app subnet. Internal Compose networks have no internet. Egress is restricted to 443 and SMTP submission |
| Database connections | `DATABASE_POOL_MAX` per process × processes must stay below the server's `max_connections` minus admin headroom. If a pooler is needed, PgBouncer in transaction mode should be compatible with the application: its tenant settings are transaction-local (`set_config(…, true)`) and its advisory locks are transaction-scoped. **This has not been tested.** The migrate job takes a session-level advisory lock, so it must connect directly, not through a transaction pooler |
| Logging | JSON to stdout, collected by the platform or a log shipper. Retention follows the audit and privacy policy. Access logs contain no bodies or tokens |
| Monitoring | Prometheus scraping `/metrics` privately with the token, Alertmanager paging, blackbox probe on `/readyz`, node exporter for disk and backup metrics. See [Observability](#observability) |
| Backups | Managed PITR plus a nightly encrypted logical backup to separate storage in the approved jurisdiction. See DISASTER_RECOVERY_RUNBOOK.md |
| Deployment and rollback | `civicsignal-deploy` (approval-gated, by digest, staging first). See [Release](#release-process) and [Rollback](#rollback) |

**Migration path A → B:**
1. Restore the latest single-host backup into the managed PostgreSQL (DISASTER_RECOVERY_RUNBOOK.md).
2. Point `DATABASE_URL` and `REDIS_URL` at the managed services.
3. Drop the `selfhosted-data` profile.
4. Add a second app host or a managed container service behind a load balancer.

The images and env files stay the same.

## Domain, TLS and network checklist

The operator performs these steps. **No domain was chosen or changed in this work.** Do not change DNS without the domain owner's authorization.

1. **Hostnames.** Choose one per environment, for example `app.<agency-domain>` and `staging.<agency-domain>`. Record who owns each zone.
2. **DNS.** Create `A`/`AAAA` (or `CNAME` to the LB) records. Keep the TTL low (300 s) during cut-over. Add `CAA` records allowing only your CA.
3. **TLS.**
   - Option A: Caddy obtains certificates automatically; ports 80 and 443 must reach the host.
   - Option B: a managed certificate on the LB.
   - Use TLS 1.2 minimum and never disable certificate verification anywhere.
   - The certificate expiry alert is `CivicSignalCertificateExpiring`.
4. **HTTPS enforcement.**
   - HTTP redirects to HTTPS (Caddy does this automatically).
   - HSTS `max-age=31536000; includeSubDomains` (in `Caddyfile.production`). Add `preload` only by the domain owner's decision.
5. **App settings.** `APP_ORIGINS` and `APP_BASE_URL` must be exactly `https://<hostname>`; startup refuses http. Set `COOKIE_SECURE=true` (the cookie becomes `__Host-cs_session`) and `TRUST_PROXY=true`.
6. **Trusted proxy.** Exactly one rewriting hop: the edge sets `X-Forwarded-For` from the real peer. With an LB in front of Caddy, configure Caddy `trusted_proxies` with the LB's private range. Never trust client-supplied headers.
7. **Security headers.**
   - The app sets the nonce CSP, `X-Frame-Options`, `nosniff`, `Referrer-Policy` and `Permissions-Policy`.
   - The edge adds HSTS and removes `Server`.
   - Verify with `scripts/smoke.mjs`.
8. **CORS.** Not enabled: the browser talks to one origin, and the API rejects mutating requests from foreign origins (CSRF origin check).
9. **Internal ports.** Only 80/443 are public. Never publish the API (4000), web (3000), PostgreSQL, Redis or Caddy admin. Compose publishes only the edge, and the stack test checks this.
10. **Internal endpoints.** `/metrics`, `/health/*`, `/api/docs` and `/api-json` return 404 at the edge. Scrape `/metrics` from inside the network with the token. API docs are off in production.
11. **Administrative interfaces.**
    - The `/platform` console is limited to platform administrators (application role).
    - Additionally restrict it by network (VPN or IP allow-list at the LB) when the customer requires it.
    - Database admin goes only through a bastion or the provider's session manager.
12. **Object storage.** None is used. If added later: private buckets, no public ACLs, signed URLs only.
13. **Egress.** Allow 443 (feeds, AI provider, YouTube, webhooks) and the SMTP submission port. Deny everything else where the platform supports it. The app's SSRF policy also blocks private and metadata addresses.

## Secrets and configuration management

- **Source of truth.** The environment's secret manager (one scope per environment). The deployment writes `/etc/civicsignal/*.env` (0600, root) or injects env vars. Nothing secret is committed, baked into images (`.dockerignore` excludes `.env*`) or exposed to the browser (the web app has no secret env vars; `API_INTERNAL_URL` is a private address, not a secret).
- **Never logged.** Config values are validated but never logged. Logs are redacted (URL credentials, bearer tokens, secret query parameters). The stack test checks that no generated secret appears in any container log.
- **Least privilege.**
  - The app uses `civicsignal_app` (RLS enforced, no BYPASSRLS, owns nothing). The owner role exists only in the migrate job.
  - The registry pull token is read-only; the CI deploy token has `packages:write` only in the images job.
  - SMTP credentials allow sending only from the configured address.
- **Separate per environment.** Staging and production never share a value.
- **Ownership.** Record a custodian and a backup custodian for each secret:

| Secret | Custodian (fill in) | Rotation |
|---|---|---|
| `DATABASE_URL` password (`civicsignal_app`) | | Set a new `APP_DB_PASSWORD` in `migrate.env` and the same password in `app.env`'s `DATABASE_URL`. Run the migrate job (it sets the role password), then restart api and worker. Brief connection errors are possible: do it in a quiet window |
| Owner DB password | | Change it in the database, then `migrate.env` |
| `REDIS_URL` password | | Managed: rotate in the provider (dual-password if supported). Self-hosted: update `redis_password` and `app.env`, then restart redis, api and worker |
| `CREDENTIALS_KEY` | | RUNBOOK.md § Rotating `CREDENTIALS_KEY` (re-encrypts connector credentials) |
| `METRICS_TOKEN` | | Update the scraper's token file first, then `app.env`, then restart api |
| `SMTP_URL` credentials | | Create the new credential at the provider, update, restart, then revoke the old one |
| `ANTHROPIC_API_KEY` | | Create the new key, update, restart, revoke the old one. Check the console's spend |
| Webhook signing secrets | Customer + operator | Per endpoint in the app (dual secrets supported during rotation) |
| `DEPLOY_HOOK_TOKEN`, `SMOKE_PASSWORD` | | GitHub environment secrets; rotate each quarter |

- **Suspected exposure.** Follow INCIDENT_RESPONSE_RUNBOOK.md § Compromised credentials. Never rotate or revoke live credentials without the custodian's authorization, and record each rotation in the change log.
- **Failed validation** stops the process before it serves traffic. The previous containers keep running because `up --wait` only replaces healthy containers. Fix the env file and redeploy; never bypass the check.

## Release process

| # | Step | Where | Status |
|---|---|---|---|
| 1 | Validate code and dependencies: secret scan (tree and history), migration safety, `npm ci` from the lockfile, `npm audit`, licences | `civicsignal-ci` | Implemented |
| 2 | Lint and typecheck | `civicsignal-ci` | Implemented |
| 3 | Unit, integration, RLS, security and e2e tests (PostgreSQL 16 + Redis 7) | `civicsignal-ci` | Implemented |
| 4 | Validate migrations: empty database, backup and restore drill, lock and expand/contract check | `civicsignal-ci` | Implemented |
| 5 | Build production images from the reviewed Dockerfiles, Trivy scan, full stack test | `civicsignal-ci` (`containers`, `stack`) | Implemented; first run pending on push |
| 6 | Deploy to staging: images pushed by digest, staging approval, agent migrates and rolls | `civicsignal-deploy` (staging) | Workflow implemented; **no staging agent exists** |
| 7 | Smoke tests: `/readyz`, then `scripts/smoke.mjs`; then the manual checklist | `civicsignal-deploy` + operator | Implemented |
| 8 | Production approval: the same SHA must have a successful staging deployment and be on the release branch; reviewers approve with self-review prevented | `civicsignal-deploy` (production) | Implemented; **release branch does not exist yet** |
| 9 | Deploy to production | Agent | Not available |
| 10 | Production-safe checks: `/readyz` and the read-only smoke test | `civicsignal-deploy` | Implemented |
| 11 | Monitor the release: error rate, p95 latency, queue lag and worker heartbeat for 30 minutes; record SHA and digests in the change log | Operator | Procedure |
| 12 | Roll back, or recover by the documented procedure | Operator / agent | [Rollback](#rollback) |

Nothing deploys automatically: the deploy workflow has no push trigger.

**Gradual rollout.** On option B, roll api and web one replica at a time, each health-checked, with the LB removing unhealthy targets. On a single host, `up --wait` recreates each service and waits for health. There is a short gap per service, so deploy in a quiet window and announce it.

**Deployment agent contract.** The workflow does not hold infrastructure credentials. It POSTs `{apiImage, webImage, commit, requestedBy, runId, migrate}` to the environment's `DEPLOY_HOOK_URL` with a bearer token. The agent runs inside the target network, is owned by the operator, and:
1. records the running digests as **previous**;
2. pulls the new images by digest;
3. runs the `migrate` job, and stops on failure;
4. rolls `api`, then `worker`, then `web`, waiting for health on each;
5. returns non-2xx on any failure, which fails the workflow.

Until an agent exists for an environment, the deploy job fails with "No deployment target is configured", and nothing is deployed.

## Database migrations

- **Mechanics** (`src/database/migrate.ts`):
  - forward-only SQL files;
  - each in its own transaction;
  - recorded with a SHA-256 checksum, and an edited applied file is refused;
  - serialized by an advisory lock, so concurrent deploys cannot interleave.
- **CI** (`scripts/check-migrations.mjs`):
  - Locked migrations (`db/migrations.lock`) must be unchanged.
  - A new migration may not drop, truncate, rename, change a column type, set NOT NULL, or run DELETE/UPDATE without WHERE, unless the line carries `-- migration-safety: <reason>`.
  - A new migration must be reviewed and then locked (`node scripts/check-migrations.mjs --lock`).
- **Expand/contract** (every migration must keep the **previous** release working):
  1. Expand: add nullable columns or new tables, and backfill in batches in a separate migration or job.
  2. Deploy code that uses them.
  3. Contract (drop or tighten) only in a later release, once no running version needs the old shape.
- **Compatibility of the current migrations:** 0001–0014 are all applied in every environment that exists (dev, test, load). 0014 only adds tables, columns, indexes, triggers and grants (plus an FK action change), so the 0013-era code keeps working against it.
- **Large tables:** `0011_search_indexes.sql` blocks writes to `sentiment_results` while its index builds. On a large table, pre-create it with `CREATE INDEX CONCURRENTLY sentiment_results_analysis_idx …` before deploying (the migration uses `IF NOT EXISTS`). Apply the same approach to any future index on a large table.
- **Before deploying a release with migrations:**
  - confirm a fresh backup or PITR point;
  - read the migration;
  - estimate lock time on production-sized data (test on a restored copy in staging);
  - schedule a window if any statement takes a write lock on a large table.
- **Detection of failure:** the migrate job exits non-zero. Its file's transaction rolls back, so the database stays at the previous migration. The agent stops; old containers keep running.
- **Handling failure:**
  - fix forward with a new migration (never edit the failed one once it is locked);
  - if data was rewritten wrongly, use the PITR path in DISASTER_RECOVERY_RUNBOOK.md.
- **Never** run a reset, reseed or `DROP` against production. Rolling back code does **not** roll back schema.

## Rollback

- **Application only** (no schema change, or a backward-compatible one): redeploy the previous digests. Use the agent's rollback, or dispatch `civicsignal-deploy` with the previous SHA. Then check `/readyz` and run the smoke test.
- **With a faulty migration** (data rewritten):
  1. freeze writes (maintenance at the edge);
  2. restore to just before the migration into a **new** instance (PITR);
  3. verify (DISASTER_RECOVERY_RUNBOOK.md);
  4. repoint and deploy the previous digests;
  5. reconcile writes made after the restore point with the customer.
- Record every rollback in the change log and the incident record.

## Observability

- **Endpoints:**
  - `/health/live` (process) and `/health/ready` (database, Redis, migrations) on the API, internal only;
  - `/healthz` and `/readyz` on the web (public, status words only);
  - `/metrics` (bearer `METRICS_TOKEN`, internal only).
- **Metrics** (aggregated across tenants, never labelled by tenant):
  - HTTP rate, status class and latency histograms;
  - process memory, CPU and uptime;
  - DB pool (`civicsignal_db_pool_connections`);
  - queue jobs and lag;
  - worker heartbeats;
  - ingestion overdue and run status;
  - analysis failures;
  - tenants with exhausted AI quota;
  - social provider-quota pauses;
  - report runs;
  - notification, webhook and billing-webhook failures;
  - report storage and database size;
  - last successful backup (textfile metric from `scripts/backup.sh`).
- **Not instrumented** (check another way):
  - usage-reconciliation drift: see the platform console's commercial health page and COMMERCIAL_OPERATIONS_RUNBOOK.md § daily checks;
  - the worker's own DB pool (the worker has no HTTP endpoint).
- **Alert rules:** `infra/monitoring/alerts.yml` (23 rules, page/ticket severities, each linked to a runbook section). Example scrape config: `infra/monitoring/prometheus.example.yml`. Both are validated with `promtool`. The thresholds are starting points from the synthetic load test; re-tune them on staging.
- **Logs:** JSON lines with `event`, `env` and `requestId`; access logs have method, route template, status and duration. Search by `requestId` from an error response.

## Capacity and scaling

- **Capacity test:** before the pilot and after major changes, run `scripts/load/seed.mjs` and `run.mjs` (LOAD_TESTING.md) against **staging** from a separate host, with the expected corpus size. Record the results in `docs/load-results/` and compare them with the previous run.
- **Scale when, for 15 minutes or more:**
  - API p95 > 1 s, or DB pool waiting > 0 → add an API replica, or raise `DATABASE_POOL_MAX` within the server's `max_connections`;
  - queue lag > 30 min with workers busy → add workers with `--no-scheduler`;
  - API CPU > 80 % from logins → edge rate limit or WAF first, then replicas;
  - database CPU > 70 % or cache hit < 99 % → larger instance, then query review.
- **Do not introduce** orchestration or new data stores without one of these signals.

## Local stack (Compose)
```bash
cp .env.example .env   # fill every empty value: openssl rand -hex 24 / openssl rand -base64 32
docker compose up --build
```
- PostgreSQL is bound to `127.0.0.1` only, and the edge listens on `127.0.0.1:3000`.
- `APP_ENV=local` allows `http://localhost`. Do not expose this stack to a network.
- The api and worker containers never receive the owner database credentials.
