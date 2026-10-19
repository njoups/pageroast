# Implementation Status

Last verified: 2026-10-19, from code, test runs and live collection (not from plans). Commands and results are at the bottom.

## Completed and verified

### Milestone 1: foundation
| Area | Evidence |
|---|---|
| Migrations 0001–0006 apply cleanly to an empty DB; re-run is a no-op; edited migrations are refused | `test/db/migrations.spec.ts` |
| RLS enabled **and forced** on all 27 tables; app role not superuser, no BYPASSRLS, owns nothing, no TEMP | migrations spec, mutation check (disabling RLS fails 7 tests) |
| Tenant isolation at DB level: read, insert, update, delete, move-between-tenants, composite FKs | `test/db/rls.spec.ts` |
| Tenant isolation over HTTP: every org route returns 404 to non-members; multi-org users see only the addressed org | `tenancy.e2e.ts`, `regressions.e2e.ts` |
| Column-level grants: app role cannot set `is_platform_admin`, move memberships, or truncate/edit audit | `regressions.e2e.ts` |
| Auth: scrypt hashing, opaque hashed sessions, logout/password-change revocation, uniform login errors | `auth.e2e.ts` |
| Login throttling per IP and per account; parallel bursts cannot exceed the account limit | `auth.e2e.ts`, `regressions.e2e.ts` |
| Roles and permission matrix; admin cannot escalate; last-owner protection (incl. across orgs); self-leave | unit + e2e |
| Invitations: hashed single-use tokens bound to recipient email; token delivered in URL fragment | e2e + browser smoke |
| Append-only audit log for sensitive operations; viewer with pagination | e2e |
| Validation and error envelope; DB date/constraint errors map to 400, not 500 | e2e |
| CSRF: foreign `Origin` rejected **through the Next.js proxy** as well as directly; JSON-only bodies | e2e + manual probe |
| Web: open-redirect guard (incl. `/\host`, `/.//host`), CSP and security headers | `apps/web/src/lib/api.test.ts`, browser smoke |
| Backup/restore drill on local PG16 | SECURITY.md |

### Milestone 2: news ingestion (verified 2026-10-19)
| Area | Evidence |
|---|---|
| Source registry: licence, authorization basis, permitted fields, full-text flag, refresh interval, rate limit, daily quota, retention, redistribution and attribution, enable/disable, health, last success/attempt/error, record count | `integration/ingestion.e2e.ts`, browser smoke |
| Authorization gate: unauthorized sources cannot be enabled or run (API + DB `CHECK`) | ingestion e2e |
| RSS 2.0 / RSS 1.0 / Atom parsing; malformed feeds, entity-expansion and HTML login pages rejected; missing dates kept null; Indonesian date formats | `unit/ingestion/feed-parser.spec.ts` |
| Conditional requests (ETag/Last-Modified → 304), `Cache-Control` honoured (capped), `Retry-After` honoured | unit + ingestion e2e (local server) |
| SSRF: blocked ranges incl. metadata, DNS checked at connect time, redirects re-validated, size/timeout/redirect limits | `unit/ingestion/url.spec.ts`, `integration/safe-http.spec.ts` |
| Pipeline with per-run stage record; licence-based field storage; licence snapshot in provenance; discovery ≠ publication time | ingestion e2e |
| Dedup: canonical URL, same-publisher content hash or headline, near-duplicate similarity; different publishers never merged | unit + ingestion e2e + live |
| Boolean query language (phrases, AND/OR/NOT, groups, prefix*, exclusions, aliases, languages), safe parser with limits, live UI validation, re-match on save | `unit/ingestion/query.spec.ts`, e2e, browser smoke |
| BullMQ queue: idempotent job ids, scheduler with `SKIP LOCKED`, per-source lock, host spacing, per-source rate/quota gates, jittered exponential backoff, DLQ, safe single retry | `integration/queue.e2e.ts` (real Redis) |
| Health from results only (unknown / healthy / degraded / failing / disabled, incl. lag) | unit + e2e |
| Metrics: attempts, success/failure, discovered, rejected, duplicates, known, matches, retries, rate-limited, latency avg/p95, lag, worker heartbeat; platform queue depth + DLQ | e2e, UI |
| Tenant isolation for sources, runs, mentions, matches, credentials (HTTP, worker, DB composite FKs) | ingestion e2e |
| UI: Sources (list, add/edit, enable/disable, collect now, runs, retry, errors), Mentions (search, filters, attribution, both timestamps), Monitoring, project queries, Overview with real data | browser smoke against live data |
| **Live:** ANTARA News Terkini RSS and CNN Indonesia Nasional RSS collected (150 records, 45 matches; second run 3 new / 147 known) | docs/CONNECTORS.md |

## Partially implemented
- **GDELT connector:** implemented and contract-tested. **Not verified live**: every attempt from this environment returned
  429/503 (shared egress IP). Health shows it honestly as failing.
- **Second *licensed* connector:** none. No commercial provider or publisher API is contracted. Encrypted credential storage
  exists (AES-256-GCM, API never returns secrets) but no connector uses it yet.
- **Pipeline stages "queue analysis" and "evaluate alerts":** recorded as `not_implemented` (Milestones 3 and 4); mentions stay `processing_status = pending`.
- **Retention:** expiry is computed per record, but nothing deletes expired records yet (Milestone 6).
- **Identity:** local adapter only (no MFA, no password reset, no email verification).
- **Rate limiting of login:** in-process memory per API instance (ingestion gates are in Redis).
- **Client IP** is trustworthy only behind an edge proxy that overwrites `X-Forwarded-For` (Caddy in Compose).
- **Docker Compose** (now with Redis + worker) validates, but images and stack have **not** been run (no Docker daemon available).
- **Conditional GET:** a 304 has been verified only against the local test server. Live feeds changed every minute or sent no ETag.

## Missing
AI analysis (sentiment, entities, summaries, clustering), alerts, analytics, reports, billing/metering enforcement, retention jobs,
export/deletion workflows, break-glass support access, social connectors, licensed-provider connector.

## Broken
None known. All automated tests pass (see bottom).

## Defects found by the 2026-10-19 audit (all fixed)
| Severity | Defect | Fix |
|---|---|---|
| High | Next proxy forwards client-supplied `X-Forwarded-For`: per-IP limits were shared by all users or spoofable | Per-account throttle; Caddy edge in Compose; documented topology requirement |
| High | Per-account throttle could be bypassed by parallel requests (check and count straddled the password hash) | Synchronous reservation before hashing |
| Medium | RLS "own rows" branch leaked a multi-org user's other memberships into tenant-scoped queries | Migration 0004 + explicit tenant filters |
| Medium | App role could set `is_platform_admin` on its own row; could rewrite membership ids | Column-level grants (0004) |
| Medium | DATE columns shifted by a day on servers east of UTC (Asia/Jakarta) | DATE parsed as string |
| Medium | Open redirect via `/\host` and `/.//host` after login | `safeNextPath` + tests |
| Medium | Some date inputs and constraint failures returned 500 | Strict `YYYY-MM-DD`; error mapping |
| Low | App role had TEMP (table shadowing on pooled connections) | Migration 0005 |
| Low | Report viewers could read member emails via project members | Requires `members:read` |
| Low | Admins could not leave an organization | `POST /organizations/:id/leave` |
| Low | Compose stack could not boot (production + insecure cookies) | `COOKIE_SECURE=true` default |

## Security risks (open)
1. **RLS context is set by the application.** An attacker with arbitrary SQL execution as the app role can set
   `app.tenant_id`/`app.system` and read any tenant. RLS guards against logic bugs, not SQL injection.
   Mitigations: parameterised queries only (no SQL string building with input), column grants, and no TEMP.
   Recommended later: per-request signed context or a separate role for system flows.
2. Local identity adapter in use (no MFA). Required before government production use.
3. Per-account lockout can be triggered by an attacker against a known email (bounded to 15 minutes).

## Data-source and licensing risks
- **No source has been legally reviewed.** The two live RSS sources are registered "for limited integration test only", with a basis
  that says so, and store headline, link and publication time only. Scheduled collection is left disabled for them.
- Fetching a publicly offered RSS feed does not grant redistribution rights. The product stores licence terms per source and snapshots
  them per record, but **deciding** what is permitted is a legal task.
- Both real feeds embed full article text (`content:encoded`); it is discarded unless the source is marked `permitsFullText`.
- GDELT's terms permit unrestricted use with citation, but its rate limits make it unsuitable as a primary source at volume.
- Retention periods are recorded but not yet enforced by deletion.

## Required external credentials
Managed IdP · email provider · Redis (required for collection) · `CREDENTIALS_KEY` (when a credentialed connector is added) · a licensed news provider or publisher API contract (for a commercial second connector) · written source authorizations.

## Test results (2026-10-19, after Milestone 2)
| Command | Result |
|---|---|
| `npm run lint` | ✔ no errors |
| `npm run typecheck` | ✔ |
| API jest (`TEST_REDIS_URL=redis://localhost:6379/15`) | **238 passed, 0 failed, 0 skipped**; three consecutive runs green |
| web `node:test` | 2 passed, 0 failed, 0 skipped |
| `npm run build` (API + web) | ✔ |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `docker compose config` | valid (stack not run: no Docker daemon) |
| Migrations 0001–0006 on the existing dev DB | applied; existing users/projects preserved |
| Live collection | ANTARA + CNN Indonesia RSS ✔; GDELT ✘ (5/5 attempts HTTP 503 → dead-lettered, as designed) |

Found and fixed during the run: a test helper bug, a Jest parallelism issue (test files share one DB/Redis, so `maxWorkers: 1` is
now in the config), and a real calibration issue from live data (60-day `max-age` on a live feed, now capped).

## Next milestone
**Milestone 3, AI intelligence:** a provider-independent LLM adapter with structured-output validation, sentiment, entities, topics,
summaries with evidence references, and event clustering. Also prompt-injection defences, plus token and model/prompt version accounting.
The new mentions table and `processing_status` are the queue input. Before that, recommended housekeeping: review the publishers' terms
and verify GDELT (or a licensed provider) from a network that is not throttled.
