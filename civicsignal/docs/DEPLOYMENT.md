# Deployment

> This describes a **reference** deployment for staging and production. **None exists yet.** No hosting provider, region or
> network has been chosen or reviewed, and nothing here is a certification or a claim of compliance with any government
> security standard (for example BSSN guidance, SPBE, or a customer's own policy). Those require independent assessment,
> and the legal requirements (UU PDP, data residency, sector rules) must be confirmed with qualified Indonesian professionals.

## Environments

| | local | staging | production |
|---|---|---|---|
| `APP_ENV` | `local` | `staging` | `production` |
| `NODE_ENV` | `production` in Compose, otherwise development | `production` | `production` |
| Data | synthetic only | synthetic or approved test data, **never** production copies unless anonymised and approved | real |
| Secrets | local `.env` (gitignored) | secret manager, separate from production | secret manager; key custodian role |
| Database | Compose `postgres` | managed PostgreSQL 16, PITR on | managed PostgreSQL 16, PITR plus multi-AZ, CMK encryption |
| Deploy | `docker compose up` | `civicsignal-deploy.yml` → staging environment | same workflow → production environment (required reviewers) |
| Access | developer | team, behind SSO or VPN | users over the internet (or agency network); admin paths restricted |

Each environment has its own database, Redis, `CREDENTIALS_KEY`, `METRICS_TOKEN`, SMTP credentials, AI key and webhook signing keys.
Nothing is shared between staging and production.

### Configuration checks at startup
The API and worker refuse to start in staging or production on any of the following:
- insecure cookies;
- a weak scrypt cost;
- disabled rate limits;
- private-host ingestion;
- the test AI provider or HTTP webhooks;
- a missing Redis;
- non-HTTPS `APP_ORIGINS` or `APP_BASE_URL`;
- `TRUST_PROXY` off;
- a `MIGRATION_DATABASE_URL` equal to `DATABASE_URL`;
- a `CREDENTIALS_KEY` that is not 32 bytes;
- a short `METRICS_TOKEN`.

Session lifetime and idle timeout are also checked (see `src/config.ts` and `test/unit/security.spec.ts`).
Values are validated, never logged.

## Reference architecture

```
Internet ──TLS──> [WAF / load balancer]  (public subnet; TLS 1.2+, HSTS, request size limits, edge rate limit on /api/v1/auth/*)
                        │
                 [edge proxy] ── [web (Next.js) ×2] ── [api ×2] ─┐        (private app subnet, no public IPs)
                                                                  ├── [managed PostgreSQL]  (private data subnet)
                                     [worker ×1..n] ──────────────┤
                                                                  └── [managed Redis, AUTH + TLS]
                     egress: [egress proxy / NAT with allow-list] ──> registered source feeds, AI provider, SMTP, webhook receivers
```

- **TLS** terminates at the load balancer with a managed certificate. Use TLS 1.2 minimum and prefer 1.3. Set HSTS `max-age ≥ 1 year` once the domain is stable.
  The edge-to-app hop stays inside the private network; enable TLS on it too if the provider's network is shared.
  `COOKIE_SECURE=true`, so the session cookie is `__Host-cs_session` (Secure, host-only, `Path=/`).
- **The edge proxy must overwrite `X-Forwarded-For`** with the real peer address. The included `infra/Caddyfile` does this. `TRUST_PROXY` must count exactly the hops between the client-facing proxy and the API, or per-IP rate limits can be bypassed by spoofing.
- **Database:**
  - no public endpoint;
  - security group allows only the api, worker and migrate tasks;
  - `rds.force_ssl` or equivalent on, with `sslmode=verify-full` in the connection strings;
  - the app connects as `civicsignal_app` (no BYPASSRLS, owns nothing);
  - only the migrate task holds the owner credentials (`MIGRATION_DATABASE_URL`).
- **Redis:** private, AUTH password (`REDIS_PASSWORD`), TLS (`rediss://`) where the managed service supports it.
- **Metrics:** `/metrics` requires `Authorization: Bearer $METRICS_TOKEN` and returns 404 when no token is set. Block `/metrics` and `/api/docs` at the load balancer from the internet and scrape from inside the network. `API_DOCS_ENABLED` is off by default in production.
- **Egress:**
  - The worker needs outbound HTTPS to registered source feeds, the AI provider, SMTP and webhook receivers.
  - The application already blocks private, loopback, link-local and metadata addresses at connect time (SSRF policy). That is not a substitute for network controls.
  - Route egress through a proxy or NAT that allows only ports 443 and 587 (SMTP submission). Where the agency requires it, also restrict destinations to an allow-list maintained with the source registry.
  - The API tier needs egress only to PostgreSQL, Redis and SMTP (password-reset email).
- **Admin access:**
  - no SSH to app hosts in normal operation;
  - database admin through a bastion or the provider's session manager, with access logged;
  - platform administrators are not tenant members by default.
- **Hosting location:** choose a region in Indonesia if residency is required (to be confirmed by counsel). Record the decision. Backups and logs must stay in the approved jurisdiction.

## Release process

1. **Change:** a pull request runs `civicsignal-ci`:
   - secret scan of the tree and history;
   - `npm ci` from the lockfile;
   - lint, typecheck, tests (unit, RLS, security, e2e) and build;
   - `npm audit` and license review;
   - migrate, backup and restore drill;
   - image build with a Trivy scan.

   At least one reviewer approves, and the PR is merged to `main`.
2. **Staging:** run `civicsignal-deploy` with `environment=staging` and the merge commit's full SHA. The workflow checks that CI passed for that SHA, builds images and pushes them by digest. After the staging approval it hands the digests to the staging deployment agent, then polls `/health/ready`.
3. **Verify staging:** smoke-test login, dashboard, mention search, one report, one alert rule test send. Check metrics for 30 minutes.
4. **Production:** the same SHA with `environment=production`. The workflow additionally requires the commit to be on `main`. The production environment's required reviewers (with self-review prevented) approve the job.
5. **After deploy:**
   - the workflow's readiness check passes;
   - the operator watches error rate, latency and queue depths for 30 minutes;
   - the operator records the deployed SHA and digests in the change log.

Nothing deploys automatically, and the workflow has no push trigger.

### Deployment agent contract
The workflow does not hold infrastructure credentials. It POSTs `{apiImage, webImage, commit, requestedBy, runId, migrate}` to the environment's `DEPLOY_HOOK_URL` with a bearer token. A small agent inside the target network, owned by the operator, then:
1. records the currently running digests as **previous**;
2. pulls the new images **by digest**;
3. runs the `migrate` one-shot (owner credentials, from the secret manager), and stops on failure;
4. rolls `api` (then `worker`, then `web`) with the new digests, waiting for health on each;
5. returns non-2xx on any failure, which fails the workflow.

Until such an agent exists for an environment, the deploy job fails with "No deployment target is configured" and nothing is deployed.

## Rollback

**Application rollback** (no schema change involved): redeploy the previous digests. Either run the agent's rollback with the recorded previous digests, or dispatch `civicsignal-deploy` with the previous SHA.
Then check `/health/ready` and the same smoke tests.

**Migrations are forward-only.** There are no down migrations, and checksummed migrations refuse edited files. So:
- Every migration must be **backwards compatible with the previous release** (expand, then contract):
  - add nullable columns or new tables first;
  - deploy code that uses them;
  - only in a later release, drop or tighten what the old code needed.
- With that rule, a rollback redeploys the previous images against the newer schema, which still works.
- If a migration itself is faulty (data rewritten wrongly), do not hand-edit production. Follow the PITR path in [DISASTER_RECOVERY.md](DISASTER_RECOVERY.md): freeze writes, restore to before the migration into a new instance, verify, repoint, deploy the previous digests.
- Reviewers check each migration for compatibility with the previous release. CI proves the migrations apply to an empty database and survive backup and restore. CI does **not** prove compatibility with the previous release; that is a review responsibility.

`0011_search_indexes.sql` takes a lock that blocks writes to `sentiment_results` while the index builds. On a large production table, pre-create the index with `CREATE INDEX CONCURRENTLY sentiment_results_analysis_idx …` before deploying (the migration uses `IF NOT EXISTS`).

## Local stack (Compose)
```bash
cp .env.example .env   # fill every empty value: openssl rand -hex 24 / openssl rand -base64 32
docker compose up --build
```
- Postgres is bound to `127.0.0.1` only, and the edge listens on `127.0.0.1:3000`.
- `APP_ENV=local` allows `http://localhost`. Do not expose this stack to a network.
- The api and worker containers do not receive the owner database credentials. Only `migrate` does.
