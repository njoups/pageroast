# Load testing

> These numbers describe **one 4-vCPU development container with 60,000 synthetic mentions**. They are a
> regression baseline and a way to find bottlenecks. They are **not** a production capacity statement. Capacity for a
> deployment must be measured on that deployment's hardware, managed database, network and data volume.

## How to reproduce

The harness runs against a **dedicated database**. `seed.mjs` refuses any database name that does not contain `load`, `perf` or `bench`.
The API and worker run as separate processes, built from `dist/`.

```bash
# 1. Empty database, migrated
psql "$ADMIN_URL" -c "CREATE DATABASE civicsignal_load"
MIGRATION_DATABASE_URL=postgres://<owner>@host/civicsignal_load npm run migrate

# 2. API + worker on that database (separate port and Redis DB). Local-only switches:
#    RATE_LIMIT_ENABLED=false so the closed loop measures the endpoints, not the limiter;
#    INGESTION_ALLOW_PRIVATE_HOSTS=true so the worker can read the local synthetic feed server; AI_PROVIDER=baseline.
#    Both switches are refused when NODE_ENV=production (src/config.ts).
PORT=4100 DATABASE_URL=... REDIS_URL=redis://localhost:6379/3 RATE_LIMIT_ENABLED=false INGESTION_ALLOW_PRIVATE_HOSTS=true \
  AI_PROVIDER=baseline node apps/api/dist/main.js &
(same env) node apps/api/dist/worker.js &

# 3. Seed: tenants, users, projects, queries, sources and report definitions are created via the API;
#    the corpus is bulk-inserted in the shape the pipeline writes (mentions, matches, current analysis, sentiment, topics).
API_URL=http://localhost:4100 LOAD_ADMIN_URL=postgres://<superuser>@host/civicsignal_load TENANTS=3 MENTIONS_PER_TENANT=20000 \
  FEED_BASE=http://127.0.0.1:4199 OUT=seed.json node scripts/load/seed.mjs

# 4. Scenarios
SEED=seed.json API_PID=<api pid> WORKER_PID=<worker pid> LOAD_ADMIN_URL=... DURATION=30 CONCURRENCY=16 \
  REPORTS_PER_TENANT=3 FEED_ITEMS=200 OUT=results.json node scripts/load/run.mjs
```

`seed.json` contains the synthetic accounts' random passwords (mode 0600). Keep it outside the repository.

### Scenarios

| Scenario | What it does |
|---|---|
| `auth.login` | Closed loop of password logins (scrypt N=2^15), concurrency ≤ 4 |
| `search` | `GET /mentions`: full-text query, deep offsets up to 2,000, and text plus sentiment filters |
| `analytics` | Six analytics metrics over 7, 30 and 90 days |
| `alerts` | Issues dashboard and alert-rule list |
| `mixed.concurrent-tenants` | Search, analytics and alerts interleaved across all tenants at 2× concurrency |
| `reports.generate` | Enqueues weekly reports (3 per tenant) and measures the time from enqueue to finished run through the worker |
| `ingestion.collect` | Enables and collects every source from a local synthetic RSS server (200 items per feed) and measures the time from trigger to finished run |
| `ai.baseline-backfill` | Requests a 500-record backfill per tenant and measures the time until the worker drains the queue (baseline analyser, no LLM) |

The runner records, per scenario:
- latency p50, p95, p99 and max, plus requests per second and status counts;
- per-operation p50 and p95;
- API and worker CPU (percent of one core) and peak RSS, from `/proc`;
- PostgreSQL transactions per second, buffer-cache hit rate, blocks read, temporary-file bytes, deadlocks, and peak active connections, from `pg_stat_database` and `pg_stat_activity`.

## Results — 2026-10-20, development container

Machine: 4 vCPU (Intel Xeon 2.1 GHz) and 15.7 GB RAM, Node 22.22, and PostgreSQL 16 on the same host. API, worker, database and load generator all share the 4 cores.
Dataset: 3 tenants × 20,000 mentions. About 60% of mentions are matched to a project and about 70% carry an analysis.
Raw output: [`load-results/2026-10-20-local-4cpu.json`](load-results/2026-10-20-local-4cpu.json).

| Scenario | Conc. | Req/s | p50 ms | p95 ms | p99 ms | Errors | API CPU | DB active (max) |
|---|---|---|---|---|---|---|---|---|
| auth.login | 4 | 38.5 | 103 | 124 | 138 | 0 / 1,159 | 341% | 2 |
| search | 16 | 167.9 | 93 | 132 | 154 | 0 / 5,048 | 46% | 11 |
| analytics | 16 | 335.1 | 36 | 54 | 460 | 0 / 10,062 | 72% | 11 |
| alerts | 16 | 535.9 | 29 | 45 | 53 | 0 / 16,088 | 81% | 5 |
| mixed (3 tenants) | 32 | 252.0 | 105 | 161 | 804 | 0 / 7,588 | 56% | 11 |

| Background scenario | Units | Outcome | p50 | p95 | Worker CPU |
|---|---|---|---|---|---|
| reports.generate | 9 weekly reports | 9 succeeded | 4.2 s | 5.8 s | 47% |
| ingestion.collect | 6 sources × 200 items | 6 succeeded, 1,200 new records | 4.5 s | 5.5 s | 53% |
| ai.baseline-backfill | 1,263 records | queue drained in 4.4 s (≈ 285 records/s) | — | — | 30% |

Peak RSS was 292 MB for the API and 277 MB for the worker. The buffer-cache hit rate stayed at or above 99.5% throughout, with no temporary files and no deadlocks.

### What the test found and what was changed
- **Mention search slowed with deep pages (fixed).**
  - Before the fix, a single request for `offset=1000` took **1,958 ms**, and search at concurrency 4 had p95 = 1.4 s.
  - Cause 1: `sentiment_results` had no index on `analysis_id`, so every listed row ran a sequential scan.
  - Cause 2: per-row subqueries also ran for every skipped offset row.
  - Fix: migration `0011_search_indexes.sql` adds `(tenant_id, analysis_id, target_type)`, and search now pages ids first and builds full rows only for the page.
  - After the fix, the same request takes **43 ms**, and `offset=10000` takes 31 ms.
  - A new e2e test checks that paged results equal the unpaged order for both an owner and a project-scoped analyst.
- **Login is CPU-bound by design.**
  - Each scrypt verification uses about 100 ms of CPU on the libuv thread pool. At 38 logins/s the API used about 3.4 cores.
  - Login capacity therefore scales with cores, not with the database.
  - This is why login and password-reset endpoints are rate-limited per IP and per account, and why `RATE_LIMIT_ENABLED=false` is refused in production.
  - A credential-stuffing burst that gets past the limiter (for example from many IPs) would consume CPU that other requests need. Put an edge rate limit or WAF in front of `/api/v1/auth/*`.
- **Analytics is mostly served from cache in this test.**
  - The scenario cycles over 18 parameter combinations, so after the first pass most requests hit the 15-minute cache (p50 36 ms).
  - The p99 of 460 ms is the uncached computation over 90 days and 20k mentions.
  - With many distinct filters, expect latencies nearer the uncached figure.
- **The database pool limits concurrency.**
  - The API's pool is fixed at 10 connections (`database.service.ts`). Peak active connections reached 11, including the sampler.
  - Above about 16 concurrent requests per API instance, requests queue for a connection, which shows as the higher p50 in the mixed scenario.
  - Scale horizontally (more API replicas), and size `max_connections` and any PgBouncer accordingly. Making the pool size configurable is a follow-up item.

### Limits of this test
- The load generator ran on the same 4 cores as the API, worker and database. Every number is pessimistic for CPU and optimistic for network latency (loopback).
- The corpus is 60k synthetic records with uniform text. Real text, real Boolean queries and 10–100× more records will change query plans.
- There was one API process and one worker. No TLS, no reverse proxy, no managed database, and no network between tiers.
- The AI scenario used the baseline analyser. LLM-backed analysis is bound by provider latency, rate limits and quotas, not by this system.
- 30-second closed-loop runs do not show long-run effects such as table bloat, autovacuum, cache eviction or memory growth. A soak test of several hours is still to do.
- The limiter was off for the closed-loop runs. Its behaviour under load is covered by the security tests, which check that a Redis-shared limit holds across two API instances.

## Before a production capacity statement
1. Run the same scenarios from a separate load-generator host against staging sized like production (managed PostgreSQL, Redis, TLS proxy, ≥ 2 API replicas), with the expected corpus size.
2. Add a soak run (≥ 4 h) and an open-model (arrival-rate) run at the target request rate.
3. Record results in `docs/load-results/` with the environment description, and compare them with the previous run.
