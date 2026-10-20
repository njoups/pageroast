# Architecture

## Shape
Modular monolith. One NestJS process exposes a versioned REST API (`/api/v1`). A Next.js app is the only
first-party client. The ingestion worker (`apps/api/src/worker.ts`) is a separate process built from the same codebase, using BullMQ on Redis.

```
Browser ─HTTPS─> Caddy edge ─> Next.js (apps/web) ─same-origin proxy─> NestJS API ──> PostgreSQL (RLS)
                                                                          │  enqueue
                                                                          ▼
                     scheduler (in worker) ──claims due sources──> Redis / BullMQ ──> worker ──SafeHttpClient──> public feeds / GDELT
                                                                          │ dead letters
                                                                          ▼
                                                                    ingestion-dlq
   pipeline commit ──enqueue──> Redis / BullMQ "analysis" ──> worker ──> AnalysisProvider (Anthropic | baseline | test)
                                                                          │ sanitise (evidence check) → persist → cluster → usage
                                                                          ▼
                                                                    PostgreSQL (RLS)
```

### Analytics and reporting (Milestone 5)
```
worker scheduler ─every 2 min─▶ refreshAnalytics(tenant): watermarks → touched hours → analytics_hourly (delete+insert) → data_version++
                 ─every 60 s──▶ reportsSchedulerTick: due schedules → report_runs (idempotency key schedule:period) → "reports" queue
                                 + re-queue orphaned runs, fail abandoned runs, delete expired artifact bytes

API analytics/* ─▶ resolveScope (visible projects, tenant time zone, half-open period) ─▶ analytics_cache (key: metric+filters+projects+period;
                   valid while data stamp unchanged and not expired) ─▶ engine (indexed base-table SQL; hourly aggregate for timelines when exact)

"reports" job ─▶ ReportGenerator: scope → metrics (same engine, one snapshot) → evidence selection → optional AI commentary
                 (sanitise + validateCommentary) → reference + consistency checks → PDF (pdfkit) / CSV → artifacts, cited sources,
                 deliveries (in-app; email = link only), audit
```
Analytics run in the same PostgreSQL database; there is no separate analytics store. Expensive work (aggregation and report
rendering) runs in the worker. API requests use indexed, bounded queries and the cache. No query loads all records into memory:
counts, distinct counts, percentiles and timelines are all computed in SQL.

### Issue detection and alerting (Milestone 4)
```
analysis done ─▶ alerts queue "evaluate" (per tenant, 5-min bucket) ◀─ scheduler (every 60 s; tenants with active rules)
                     │ per-tenant lock + evaluation ledger
                     ▼
   refresh activity_hourly / topic_activity_daily ─▶ per rule: population + coverage ─▶ detect() ─▶ severity ─▶ issue upsert
                                                                                                      │ outbox rows
                     ┌──────────────────────────────────────────────────────────────────────────────────┘
                     ▼
   notification_deliveries (in_app delivered immediately; email/WhatsApp queued) · webhook_deliveries ─▶ "deliver"/"webhook" jobs
                     ─▶ SMTP / WhatsApp Cloud API / SafeHttpClient POST (signed)  ── final failure ─▶ alerts-dlq
```
| Component | File | Notes |
|---|---|---|
| Rule configuration | `alerts/rule-config.ts` | Zod schema, type-specific checks, keyword expressions via the bounded query parser |
| Detection maths | `alerts/detection.ts` | Pure functions over arrays; windows, coverage gaps, robust z, proportions, per-signal candidates |
| Severity | `alerts/severity.ts` | Documented points table, caps, floors |
| Population and aggregates | `alerts/population.ts` | Filtered records, collection coverage, idempotent aggregate refresh |
| Evaluator | `alerts/evaluator.service.ts` | Ledger, dedup/reopen/cooldown, escalation, events |
| Notifications | `alerts/notifications.service.ts`, `alerts/channels/*` | Outbox planning, quiet hours, quotas, rate gates, email/WhatsApp/webhook senders |
| Issue summary | `alerts/issue-summary.service.ts` | LLM with record refs, else extractive |
| Queue, worker, scheduler | `alerts/alerts-queue.ts` | Job ids = idempotency keys; jittered backoff; DLQ; recovery sweep; queue health |
| API | `alerts/issues-api.ts`, `alerts/rules-api.ts` | Issues, dashboard, rules, notifications, webhooks |
| Clock | `alerts/clock.ts` | Injected time source (tests use a fixed clock) |

Docs: ALERT_RULES.md (methods, severity, lifecycle), NOTIFICATIONS.md (channels), RUNBOOK.md (operations).

### AI intelligence (Milestone 3)
| Component | File | Notes |
|---|---|---|
| Ledger, run, persist | `analysis/analysis.service.ts` | `mention_analyses` row claimed atomically; language → validation → provider → sanitise → persist + cluster in one transaction → usage → finish |
| Queue + worker | `analysis/analysis-queue.ts` | Job id from ledger id; provider rpm gate in Redis; `UnrecoverableError` for non-retryable kinds; prompt-version registry |
| Providers | `analysis/providers/*` | `AnalysisProvider` interface; Anthropic (SDK, structured output, typed errors), rule-based baseline, deterministic test provider |
| Contracts + sanitisation | `analysis/schemas.ts` | Zod schemas; `sanitizeArticleAnalysis` / `sanitizeMultiSummary` enforce verbatim evidence and valid record refs |
| Prompts | `analysis/prompts.ts` | Versioned system prompts; untrusted content in nonce-tagged blocks |
| Language, taxonomy, baseline | `analysis/language.ts`, `taxonomy.ts`, `baseline.ts` | Deterministic, auditable rules (method `baseline`) |
| Clustering | `analysis/clustering.ts`, `cluster.service.ts` | Pure scoring + persistence with membership history and events; per-tenant advisory lock |
| Summaries | `analysis/summaries.service.ts` | Mention, cluster, project, period; LLM with refs or extractive |
| Usage and quotas | `analysis/usage.ts` | Append-only usage, pricing lookup with timestamp, quota state |
| API | `analysis/analysis-api.ts`, `filters.ts` | Analysis detail, reprocess/backfill, analytics, clusters, topics, entities, summaries, usage/settings |

Analytics are computed on read from the *current* analysis of each original record (`mentions.analysis_id`); earlier analyses
stay for history and reprocessing. Configuration: docs/AI_PROVIDERS.md. Quality: docs/AI_EVALUATION.md.

### Ingestion (Milestone 2)
| Component | File | Notes |
|---|---|---|
| Connector contract + error taxonomy | `ingestion/connectors/connector.ts` | Shared by all connectors; retryable vs permanent |
| RSS/Atom connector | `ingestion/connectors/feed.connector.ts` | One conditional GET per run |
| GDELT DOC 2.0 connector | `ingestion/connectors/gdelt.connector.ts` | Public, no credentials; host spacing 6 s |
| SSRF-safe HTTP | `ingestion/safe-http.ts`, `ip-policy.ts`, `url.ts` | IP checks inside the socket DNS lookup, re-applied per redirect |
| Feed parser | `ingestion/feed-parser.ts` | fast-xml-parser; rejects entity declarations; plain-text output |
| Pipeline | `ingestion/pipeline.service.ts` | Fetch→validate→normalise→dedup→match→persist→(analysis)→(index)→(alerts)→metrics, all in `withTenant` |
| Queue, gates, scheduler | `ingestion/queue.ts` | Job id = idempotency key; per-source lock, host spacing, rate/quota gates; jittered backoff; DLQ |
| Query language | `ingestion/query.ts` | Recursive-descent parser → AST, evaluated in memory |
| Registry, queries, mentions APIs | `ingestion/sources.*`, `queries.ts`, `mentions.ts` | Permissions: `sources:*`, `projects:*`, `mentions:read` |

Data model: `sources` (registry and licence), `connectors` (kind, config, HTTP validators), `connector_credentials` (ciphertext only),
`ingestion_schedule` (cross-tenant scheduling metadata, no content), `connector_runs` (ledger and metrics),
`mentions` (one per tenant + canonical URL), and `mention_matches` (mention ↔ project/query).
The scheduler reads `ingestion_schedule` in system context. Every read or write of tenant data, by API or worker, runs under that tenant's RLS context.

The browser never talks to the database directly. Browser→API calls are same-origin through the Next.js rewrite
(`/api/*`), so session cookies are first-party and `SameSite=Lax`.

### Social listening (Prompt 07)
```
scheduler ─> ingestion queue ─> worker: YoutubeConnector (SafeHttpClient, X-Goog-Api-Key) ─> pipeline (social fields, provider-id dedup,
            ▲ pre-flight: pause / budget / provider quota            refresh-on-reseen, 30-day deadlines, provider_usage)
            │                                                         └─> analysis queue only if provider rights allow (approval)
lifecycle job (15 min): refresh due records by id ─> update | purge (gone at provider / past deadline) | blocked by legal hold
```
News and social records share tables and pipeline but are never combined silently: executive analytics, reports, dashboard
aggregates and alert rules default to news; `/social/analytics` reports social data with its own definitions.

## API modules (apps/api/src)
| Module | Responsibility |
|---|---|
| `database` | Pool, migrations runner, `withTenant()` / `withSystem()` transaction helpers |
| `identity` | `IdentityProvider` port; `LocalIdentityProvider` (scrypt + opaque DB sessions with absolute and idle expiry, session list/revoke, password-reset tokens) |
| `auth` | Register/login/logout/me, sessions, password reset, session guard (`__Host-cs_session`), Redis-shared rate limiting |
| `organizations` | Org creation, settings, memberships, invitations |
| `projects` | Projects, project members, archive/delete |
| `audit` | Append-only audit writer (event id, outcome, request id, redacted metadata) and viewer; a trigger hash-chains every event per tenant |
| `authz` | Role → permission matrix, `@RequirePermission()` guard |
| `health` | `/health/live` (process), `/health/ready` (database, Redis, migrations current), token-protected `/metrics` (HTTP, queue, ingestion, report, notification, AI-quota and DB-size gauges); request metrics and access-log middleware |
| `social` | Social listening: provider descriptors and capability matrix (`providers.ts`), provider quota, budgets and cost estimates (`quota.ts`), derived-analysis rights gate (`rights.ts`), lifecycle refresh-or-delete job (`lifecycle.service.ts`), `/social` API and social analytics. Social connectors are sources of a social kind (`youtube`) and flow through the same ingestion pipeline and AI analysis. |
| `governance` | Retention enforcement (`RetentionService`, daily per tenant, advisory-locked, dry-run counts, ledger), legal hold, four-eyes deletion requests, `purgeMentions` (cascade + artifact expiry + analytics invalidation) |
| `analytics` | Analytics engine (coverage, sentiment, share of voice, sources, topics, entities, issues, overview), hourly aggregation, cache, time-zone math |
| `reports` | Report definitions, templates, generator (evidence workflow), PDF/CSV renderers, schedules, queue + scheduler, downloads |

## Reliability patterns (hardened in Prompt 09)
- **Claim before side effect.** Email and webhook deliveries, and usage-notice emails, move to `sending` with `claimed_at` in one atomic `UPDATE … RETURNING` before anything is sent. A stale claim (worker died) is reclaimed by the alerts tick. Permanent failures end as `dead`. This prevents duplicate sends across workers and retries.
- **Usage serialization.** A per-tenant advisory lock is taken shared by `consume()` and exclusive by reconciliation and corrections, so a reconcile can never overwrite usage recorded concurrently.
- **Spend recorded outside the business transaction.** AI token usage is written in its own transaction right after the provider call, so failed or rolled-back analyses are still metered.
- **Provider events are matched, not trusted.** Billing webhooks act only when the event's subscription reference and checkout session match recorded state. Unknown references are retried. Paid invoices and billing periods only move forward.
- **Time zones are frozen where periods depend on them.** `subscriptions.usage_timezone` is set with the usage anchor. Analytics date-only bounds are tenant-local days. Social budget periods follow the provider's own clock (Pacific time for YouTube).

## Tenant isolation (defence in depth)
1. **Database (authoritative):** every tenant-owned table has `tenant_id`, `ENABLE` + `FORCE ROW LEVEL SECURITY`, and a
   policy `tenant_id = app_current_tenant()`. The API connects as `civicsignal_app` (no superuser, no BYPASSRLS, not the owner).
2. **Request context:** `withTenant(tenantId, fn)` opens a transaction and runs `SELECT set_config('app.tenant_id', $1, true)`
   (transaction-local, so it cannot leak across pooled connections).
3. **Service layer:** `TenantGuard` resolves the caller's membership for the `:orgId` in the route, then checks the permission.
   A non-member gets 404 (not 403) so tenant existence is not disclosed.

Pre-tenant flows (login, registration, session lookup, organization creation, invitation redemption) run in an explicit
*system context* (`app.system = on`, via `withSystem()`/`run({system:true})`). Only the policies on `users`, `sessions`,
`tenants`, `memberships` (insert), `invitations` and null-tenant `audit_events` honour it; every domain table ignores it, so
system context can never read customer content. A user context (`app.user_id` only) sees just the caller's own memberships.

**Known limit:** RLS context is set by the application. It protects against missing `WHERE` clauses and logic bugs, not
against arbitrary SQL execution by an attacker who already controls the app's database session.

## Identity
`IdentityProvider` abstracts credential verification and session issuance. `LocalIdentityProvider` stores scrypt hashes and
SHA-256 hashes of opaque 256-bit session tokens. Sessions expire absolutely (`SESSION_TTL_SECONDS`, ≤ 7 days) and after
inactivity (`SESSION_IDLE_SECONDS`); users can list and revoke them. Password reset uses single-use hashed tokens by email and
revokes every session. The local provider exists so the product runs without external credentials; it reports
`capabilities.mfa = false`. A managed OIDC provider with MFA must be added behind the same port before production. MFA is
**not** implemented, and none is emulated.

## Authorization
Roles: `platform_admin` (user flag, not a membership), `owner`, `admin`, `project_manager`, `analyst`, `report_viewer`.
The matrix lives in `apps/api/src/authz/permissions.ts` and is the single source of truth; docs/SECURITY.md mirrors it.
Platform admins hold no tenant permissions. Operational access to customer content will use time-boxed, reasoned,
audited break-glass grants (not built). Denied tenant access by a member is audited (`authz.denied`).

## Error envelope
`{ "error": { "code": "validation_failed", "message": "...", "details": [...], "requestId": "..." } }`

## Data model
See `db/migrations` (0001–0012). 0012 adds social listening: the `youtube` connector kind, provider rights, approval and pause
state on connectors, platform fields on mentions (platform, content type, provider id, parent, hashtags, engagement as returned,
refresh and deletion deadlines), analysis provenance (news vs social), `provider_usage`, `provider_pricing`, `social_budgets`,
`social_budget_events` and `provider_lifecycle_runs`. 0011 adds a search index found missing by the load test. 0010 adds session idle tracking,
password-reset tokens, the audit hash chain (`audit_chain_heads`, `audit_verify_chain`), `tenant_data_controls` (legal hold),
`retention_runs` and `deletion_requests`. 0009 is analytics and reporting. 0008 adds the alerting tables (see ALERT_RULES.md) and replaces the unused placeholder alert tables. 0007 adds `mention_analyses`, `entities`/`entity_aliases`, `project_topics`, `cluster_members`/`cluster_events`,
`ai_summaries`, `ai_usage_records`, `ai_pricing`, `ai_prompt_versions`, `ai_tenant_settings`. Tables for alerts, reports and billing exist but are not yet used.
