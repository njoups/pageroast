# Implementation Status

Last verified: 2026-10-20, from code, test runs and live collection (not from plans). Commands and results are at the bottom.

## Completed and verified

### Milestone 1: foundation
| Area | Evidence |
|---|---|
| Migrations 0001–0007 apply cleanly to an empty DB; re-run is a no-op; edited migrations are refused | `test/db/migrations.spec.ts` |
| RLS enabled **and forced** on all 38 tables; app role not superuser, no BYPASSRLS, owns nothing, no TEMP | migrations spec, mutation check (disabling RLS fails 7 tests) |
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

### Milestone 3: AI intelligence engine (verified 2026-10-19; AI model **not** live-verified)
| Area | Evidence |
|---|---|
| Async pipeline: language → content validation → entities/topics/sentiment/summary (one structured call) → sanitise → persist → cluster → usage; ingestion never waits | `integration/analysis.e2e.ts` (real Postgres + Redis, test provider) |
| Idempotent ledger (`mention_analyses`): atomic claim, duplicate deliveries are no-ops, crashed attempts reclaimed, persist failures recorded; history kept, one current result | analysis e2e |
| Retries with backoff (provider `retry-after` honoured); non-retryable errors not retried; outage/refusal → baseline result marked `partial` (or `failed` with `AI_FALLBACK=none`) | analysis e2e, `unit/analysis/guards.spec.ts` |
| Providers: rule-based baseline, deterministic test provider (refused in production), Anthropic adapter (structured output validated locally, typed error mapping, refusal fallback, timeouts) | `unit/analysis/anthropic-adapter.spec.ts` (**mocked HTTP**), `config.spec.ts` |
| Language: id/en analysed; Malay, Javanese, other scripts and undetermined text are skipped and never treated as Indonesian | `unit/analysis/baseline.spec.ts`, analysis e2e, live data |
| Evidence contract: entity/sentiment/topic evidence must occur verbatim in the source; unknown topics dropped (→ "unknown", never forced); summary claims need a quote or valid record refs | `guards.spec.ts`, analysis e2e (prompt-injection case) |
| Prompt-injection containment: nonce-tagged untrusted blocks, forged tags neutralised, fabricated output removed by the evidence check | `guards.spec.ts`, analysis e2e |
| Entities with type, evidence span, confidence and method; exact-alias resolution, never merging similar names; analyst alias management | analysis e2e |
| Topics: taxonomy `gov-pa/1` + project categories; sentiment: 5 labels, target, evidence, uncertain flag | analysis e2e |
| Story clustering (headline/entity/topic similarity, time window, syndication flag, merges, append-only events), safe under concurrent workers | `guards.spec.ts`, analysis e2e (race reproduced without the lock) |
| Summaries: mention, cluster, project and period; each claim cites records; conflicts and caveats; hidden-record claims filtered per viewer | analysis e2e |
| API: analysis detail, reprocess (permission, audit, per-minute dedupe, tenant rate limit), backfill (pending/stale/failed), analytics, clusters, topic categories, entity aliases, summaries, usage and settings; platform pricing | analysis e2e |
| Tenant and project isolation for all analysis data | analysis e2e (cross-tenant, unassigned member) |
| Cost: token accounting per call (append-only), operator-set prices with timestamp (none shipped), estimate null without a price, per-tenant daily/monthly quotas enforced at run time | analysis e2e |
| UI: mention detail (source content / automated classification / summary / processing clearly separated), Analytics (filters, tone, topics, entities, stories, methods), Stories list + detail with citations, project topic categories + summaries, admin AI usage and limits | browser smoke against live data |
| **Live:** 153 real records re-analysed by the baseline worker: 150 analysed, 2 skipped (undetermined language), 10 stories | dev database |
| Evaluation: development + held-out sets, per-class precision/recall/F1 | `npm run eval:ai`, docs/AI_EVALUATION.md |

### Milestone 4: issue detection and alerting (verified 2026-10-19 on live data; email via a local SMTP server only)
| Area | Evidence |
|---|---|
| Migration 0008 (replaces the unused placeholder alert tables, guarded against data loss): rules + immutable versions, issues, events, evidence, assignments, notes, notification deliveries/preferences, webhooks + deliveries, hourly/daily aggregates, evaluation ledger; 50/50 tables with forced RLS; history append-only | migrations spec, alerts e2e (privilege check) |
| Detection on persisted records: volume spike (median/MAD robust z, ratio, minimum counts, covered-window baselines), negative-share shift (confident classifications only, uncertainty and sample suppression), emerging topic, critical keyword, story velocity, single-publisher concentration; article/story/issue scope; syndication never counted as independent | `unit/alerts/detection.spec.ts`, alerts e2e, live run |
| Historical gaps: comparison windows without successful collection are excluded and reported | unit + e2e (fixture gap day) + live (0/14 covered → suppressed) |
| Transparent points-based severity with stored breakdown, caps and rule floors; analyst review steps | unit + e2e |
| Dedup per rule+subject, idempotent evaluation ledger, per-tenant lock, automatic reopen on new evidence, cooldown (incl. across close), related-issue grouping, escalation once per level | alerts e2e (controllable clock) |
| Rule versioning; issues keep their creating version; soft-deleted rules keep their issues | alerts e2e |
| Lifecycle Detected → Pending review → Acknowledged → Investigating → Resolved → Closed, reopen; reasons, notes, assignment validation, audit (note text not copied) | alerts e2e, browser smoke |
| In-app inbox + bell, preferences; email (HTML+text, header-safe) end to end through SMTP; quiet hours; daily quota; channel rate limits; retries with jitter; DLQ; manual retry; recovery sweep | alerts e2e (local SMTP server), unit, live run (dev mail sink) |
| Webhooks: HTTPS + SSRF policy, verification handshake, HMAC signatures with timestamp, rotation grace period, no redirects, retries → DLQ, auto-disable, delivery log | unit (local receiver) + alerts e2e |
| WhatsApp: official Cloud API template adapter; reported as unconfigured without credentials | unit (mocked HTTP), live channel status |
| API: rules CRUD + dry-run test/preview, issues list/filter/detail/actions/notes, dashboard, notifications, preferences, delivery log, webhooks, platform queue health; permission-checked, tenant-isolated, rate-limited, audited | alerts e2e |
| Dashboard: high-priority issues, counts, volume chart with baseline and gaps, tone chart, emerging topics, timeline, related stories, collection freshness, filters (project, entity, topic, severity, source, date range, status, assignee); issue detail; rule editor with dry run; notifications; admin delivery log/webhooks | browser smoke on live data, no console errors |
| **Live:** 58 new real records collected (ANTARA, CNN Indonesia), analysed, evaluated by 6 rules: 1 high-severity keyword issue (29 records, 2 publishers) with in-app and email notification; volume/emerging rules suppressed (no baseline yet), tone rule suppressed (baseline tone 100% uncertain), story/concentration detections below the rules' severity minimum | dev database, mail sink |

### Milestone 5: analytics and executive reporting (verified 2026-10-20 on live data; AI commentary not verified with a live model)
| Area | Evidence |
|---|---|
| Migration 0009 (replaces the unused placeholder report tables, guarded against data loss): hourly analytics aggregate + per-tenant data version and watermarks, analytics cache, report definitions/schedules/runs/cited sources/artifacts/deliveries; new period indexes; 57/57 tables with forced RLS; cited sources append-only, runs not deletable by the app role | migrations spec, dev DB |
| Analytics engine: coverage (records vs unique articles vs publishers vs story clusters, previous period, rolling 1/7/30-day comparisons, local-time timelines), sentiment (unknown/unanalysed counted, excluded from denominators, by topic/entity/publisher, confidence + method, limitations), share of voice (documented formula, configurable group, co-mentions, warnings, no reach estimates), sources (share, active days, lag, Simpson diversity, topics, tone), topics/entities (emerging, trends, co-occurrence, issue associations), issues | `reports.e2e.ts` (exact expected values on fixtures), live API |
| Half-open periods, tenant time zone (bucket shift verified by switching the org to UTC), DST-safe local-midnight conversion, maximum period, duplicates excluded | unit `tz-metrics.spec.ts`, e2e |
| Incremental hourly aggregation (watermarks, daily full rebuild) in the worker; aggregate used for timelines only when exact and current, with a self-check against base totals | e2e (aggregate = base; stale and deleted cases fall back), live (42 hourly rows = 53 project memberships of 50 matched records) |
| Cache keyed by metric, filters, visible projects and period; invalidated by new data (data stamp) and by the data version; freshness never cached | e2e |
| Tenant and project isolation: other tenant's records never counted, unassigned members 404 on the project and see 0, report viewers have no analytics access | e2e |
| Executive dashboard: KPIs (articles, records, publishers, net tone, high-priority issues, active sources), coverage timeline, tone, share of voice, top issues, trending topics, top topics, entity comparison, freshness & connector health, active sources; filters for period/custom dates (tenant tz), project, entity, topic, source, language, tone, issue status, SoV group; per-widget title, metric definition, period, loading/empty/error states, accessible charts with tooltips and table views | browser smoke on live data (tooltip, table view, filtered view), no console errors |
| Five versioned templates (daily, weekly, monthly, issue, policy) in Indonesian and English; typed paragraphs (metric / source fact / AI interpretation / analyst recommendation / note); no causal, opinion or effectiveness wording in template text | unit (all templates × both languages), **live: all five generated on real data** |
| Evidence workflow with reference validation and metric-consistency checks (fail rather than render) | unit + e2e; consistency check caught a real aggregate staleness bug during development (fixed) |
| Optional AI commentary: sanitised refs + `validateCommentary` (unsupported numbers, causal, public-opinion, effectiveness, forecast, unverified quotations), token usage recorded, tenant token limit respected; "unavailable" stated with the baseline | unit (12 cases), e2e with the test provider (4 of 5 claims dropped for the right reasons) |
| PDF (cover, hierarchy, KPI tiles, tables, vector charts, numbered sources, page x/y, timestamp, period, attribution, methodology, limitations; Liberation fonts) and CSV (stable columns, quoting, CRLF/BOM, ISO timestamps, formula neutralisation, licence-aware excerpts, bodies never exported, row limit) | unit, e2e, live downloads inspected (rendered pages reviewed) |
| Authenticated downloads only (project access + reports:read, audited, safe headers, sanitised filenames), expiry → 410 with metadata kept | e2e |
| Schedules: daily/weekly/monthly/custom in the schedule time zone, idempotent per (schedule, period), no back-fill, recipients validated at creation and re-checked at delivery, in-app + link-only email (unconfigured recorded honestly), edit/pause/cancel, failure notices, consecutive-failure count | e2e (controllable clock) |
| Reliability: retries (transient failures re-queued, final failure visible), abandoned-run sweep, long-queued cancellation, orphan re-queue, per-tenant daily/concurrent quotas, platform report health endpoint | e2e, `GET /platform/reports` |
| **Live:** migration applied to the dev DB (211 real records preserved); 8 reports generated from the 50 matched records (CNN Indonesia, ANTARA); AI commentary reported as unavailable (baseline provider) | dev database |

### Production-readiness hardening (verified 2026-10-20 in the development container; no staging or production exists)
Full findings, severities, open risks and acceptance criteria: [PRODUCTION_READINESS_ASSESSMENT.md](PRODUCTION_READINESS_ASSESSMENT.md).
| Area | Evidence |
|---|---|
| Sessions: idle timeout, `last_seen_at`, list/revoke one/revoke others; `__Host-cs_session` cookie | `integration/security.e2e.ts` |
| Password reset by email (single-use hashed token, 30 min, 3/h, uniform response, revokes sessions; 503 without SMTP); web pages `/forgot-password`, `/reset-password` (token from URL fragment) | security e2e; web build |
| Rate limits shared across API instances via Redis; refused off in production | security e2e (two app instances) |
| Tenant isolation audit: cross-tenant route matrix, DB-level isolation for every tenant table, jobs with a foreign tenant id, artifact downloads; 10 authorization/visibility leaks fixed (F1–F7) | security, analysis, alerts e2e |
| Audit: event id, outcome, request id, per-tenant SHA-256 hash chain with tamper detection; credential-like metadata redacted; `authz.denied` audited | security e2e, unit tests |
| Retention enforcement (licence expiry, body, metadata, derived analysis, reports; dry-run; ledger; daily), legal hold, four-eyes deletion requests, purge with artifact expiry and analytics invalidation | security e2e |
| Startup configuration validation; production refusals; secrets redacted from logs and errors; Swagger off in production | `unit/security.spec.ts` |
| `/health/live`, `/health/ready` (DB, Redis, migrations), `/metrics` (token), access logs with request id; worker heartbeat healthcheck | security e2e; container smoke |
| Resource limits: linear HTML stripping (was quadratic), markup cap, body-size errors 413/400, AI summary quota + rate limit, dashboard span cap | unit + e2e |
| CSP nonce + `strict-dynamic`; `safeHref`; IPv6 SSRF ranges; GCM tag length | web tests; production container check |
| Backup with manifest (rows, migrations, privilege fingerprint) + checksum + optional GPG; `verify-restore.sh` 6-step drill incl. privilege comparison; drill in CI | BACKUP_AND_RECOVERY.md verification record |
| Load-test harness and results (one 4-vCPU host; not a capacity claim); search fix from it (migration 0011) | LOAD_TESTING.md |
| CI: secret scan (tree + history), licence review, restore drill, image build + Trivy; manual deploy workflow with approval and readiness check | `.github/workflows/` |
| Images: Debian updates applied, no npm in runtime, non-root; Trivy 0 fixable HIGH/CRITICAL; api ready and web `/login` served from the containers | SUPPLY_CHAIN.md |

### Social listening engine (Prompt 07; verified 2026-10-20 against a MOCK provider only)
Details, provider capability matrix, data rights and limits: [SOCIAL_CONNECTORS.md](SOCIAL_CONNECTORS.md).
| Area | Evidence |
|---|---|
| Provider-independent framework: descriptors (operations, fields, metrics, limits, quotas, pricing model, rights, documentation links with read date), optional connector operations (usage estimate, refresh, connection test), per-bucket usage reports | `social/providers.ts`, `ingestion/connectors/connector.ts`; descriptor consistency unit tests |
| YouTube Data API v3 connector: keyword search, channel monitoring, optional public comments, refresh by id, connection test; key only in `X-Goog-Api-Key`; only returned metrics; quota/rate-limit/key/API-disabled error mapping | `test/unit/social/youtube.spec.ts` (27) |
| Social records in the existing pipeline: platform, content type, provider id, parent, hashtags, engagement as returned, 30-day refresh/deletion deadlines; provider-id dedup; refresh-on-reseen; matching against project queries | `integration/social.e2e.ts` |
| Derived analysis gated by provider rights (YouTube needs a recorded approval); analyses record news vs social, platform and content type; short texts marked; record kind passed to the analyser | social e2e |
| Quota and cost: `provider_usage` per provider day (Pacific Time for YouTube) and bucket; pre-flight quota check; pause on exhaustion until reset; budgets warn/soft/hard with notices; cost only from verified pricing rows, else "not priced"/"incomplete" | social e2e |
| Lifecycle: refresh due records, purge records gone at the provider or past the deadline, legal hold blocks deletion and is audited | social e2e |
| Social analytics with stated denominators; tone by platform and content type; conversation-level distributions; engagement per record (no aggregation for YouTube); cross-platform entities; issue timeline. Executive analytics, reports, dashboard aggregates and alert rules default to news only | social e2e; full suite unchanged |
| `/social` API (providers, connectors CRUD/credentials/test/sync/enable/health/usage/approval, budgets, mentions, analytics, issue timeline) with permissions, validation, pagination, rate limits and audit | social e2e |
| Tenant isolation of connectors, usage, budgets, lifecycle runs and social records (API 404s, RLS read and write) | social e2e |
| Web: Social listening workspace (connectors with status, quota bars, notices, actions, capabilities, data rights, usage and cost, sync history; analytics; mentions; provider matrix; budgets); social items labelled on Mentions | `lib/social.test.ts`; browser smoke 2026-10-20 (no console errors) |
| **Live provider verification** | **Not done: no YouTube API key (or other provider credential) was available.** An unauthenticated request to the real endpoint returned HTTP 403 `forbidden`, confirming reachability and the error envelope only. |

## Partially implemented
- **AI report commentary:** implemented and tested with the deterministic test provider only. No API key was available, so it has
  **not** run against a live model. With the baseline provider, reports say that AI commentary is unavailable.
- **Report email delivery:** reuses the SMTP channel (link only). Verified in tests as recorded `unconfigured`; the alert email path was
  verified against a local SMTP server in Milestone 4. No third-party provider has been tested.
- **Deleted records and the analytics cache:** resolved. Retention and deletion purges now invalidate aggregates and drop the
  analytics cache in the same transaction (`governance/purge.ts`).
- **GDELT connector:** implemented and contract-tested. **Not verified live**: every attempt from this environment returned
  429/503 (shared egress IP). Health shows it honestly as failing.
- **Social listening:** YouTube connector implemented and contract-tested; **not verified live** (no API key). X, Reddit, Meta and
  licensed providers have descriptors only (capability matrix), no connectors. OAuth flows are not built (no implemented provider uses OAuth).
- **Second *licensed* connector:** none. No commercial provider or publisher API is contracted. Encrypted credential storage
  exists (AES-256-GCM, API never returns secrets) but no connector uses it yet.
- **AI model analysis:** the Anthropic adapter is implemented and tested against mocked HTTP only. **No API key was available, so it
  has not been verified live**, and all stored analysis comes from the rule-based baseline. The baseline's sentiment is weak on held-out
  data (40.9 % accuracy; see AI_EVALUATION.md) and is shown as uncertain.
- **Entity-level sentiment:** produced only by the AI model path; the baseline gives article-level tone only.
- **Email:** verified only against a local SMTP server; no third-party email provider has been configured or tested.
- **WhatsApp:** adapter only (mocked HTTP); no Business account, number or approved template available.
- **Detection on young data:** baselines need `minBaselineWindows` covered windows (default 5 days for daily-aligned rules), so volume,
  emerging-topic and tone rules stay suppressed on a fresh deployment. Tone rules stay suppressed while tone comes from the baseline method.
- **Regional anomaly detection:** not implemented (no reliable geographic metadata; see ALERT_RULES.md).
- **Source reliability** is not scored (no reliability metadata yet); recorded as such in every severity breakdown.
- **Summaries on headline-only sources:** live sources permit headlines only, so mention summaries are mostly "insufficient evidence"
  and cluster/project summaries are extractive (quotes and counts).
- **Retention:** enforced when a tenant enables it (off by default); audit events are never purged by it. Retention defaults for a
  tenant still need a legal decision.
- **Identity:** local adapter only: password reset and session management exist; **no MFA** and no email verification.
- **Client IP** is trustworthy only behind an edge proxy that overwrites `X-Forwarded-For` (Caddy in Compose).
- **Docker images** build and were smoke-tested individually (API ready against PostgreSQL and Redis; web served `/login`). A full
  `docker compose up` of all services together has **not** been run.
- **Conditional GET:** a 304 has been verified only against the local test server. Live feeds changed every minute or sent no ETag.

## Missing
Entity/summary/clustering quality evaluation, report branding beyond colour (logo upload), PDF/UA tagging (accessible PDF structure), analyst annotations (UI area reserved; no storage yet), 
tenant data export, MFA (needs an IdP), staging/production infrastructure, break-glass support access, social connectors other than
YouTube, live verification of any social provider, social connectors, licensed-provider connector.

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

## Defects found during Milestone 3 (all fixed, with regression tests)
| Severity | Defect | Fix |
|---|---|---|
| High | Concurrent analysis workers raced on story membership (unique violation); the job then retried as "not claimed", leaving the record stuck in `running` | Per-tenant transaction lock for clustering; persist failures recorded as `retrying`/`failed`; later attempts reclaim crashed rows |
| Medium | A model refusal surfaced as a parse error and was classified as a retryable network error | Validate output locally after checking `stop_reason`; unknown SDK errors → `invalid_output` |
| Medium | 14 % of real Indonesian headlines were "undetermined" (headlines lack function words) | Headline vocabulary (lexical-profile/2), evaluated on a held-back half of live headlines |
| Medium | Malay text with shared vocabulary was labelled Indonesian | Strong-Malay-spelling rule |
| Medium | "Stale" backfill could not reach records skipped under an older configuration | Stale scope includes skipped records |
| Low | Empty `AI_*` variables (as Compose passes them) broke config validation | Empty = unset |
| Low | Story "independent" count counted one outlet's follow-ups as independent | Distinct publishers among non-syndicated records |
| Low | Extractive summaries were labelled "AI-generated" in the UI | Separate "Automated extract" label |
| Low | Entity extraction preferred a short gazetteer match over a longer institution name | Longest-span selection |
| Low (CI) | Queue tests depended on test-file order: the scheduler picked up sources enabled by another test file, so CI was red since the Milestone 2 push while local runs passed | Queue test deactivates foreign schedules and counts only its own dead letters; reproduced and verified with a forced file order |

## Defects found during Milestone 4 (all fixed)
| Severity | Defect | Fix |
|---|---|---|
| Medium (CI) | Queue tests were order-dependent (CI red since the Milestone 2 push) | Test isolation; reproduced with forced order |
| Medium | Dashboard query passed an unused parameter (500) | Separate parameter lists per query |
| Low | Keyword issues listed a baseline-gap limitation although keyword rules use no baseline | Limitation only for baseline signals |
| Low | Notification rationale omitted severity adjustments (rule floor) | Adjustments included |
| Low | Disabled sources flagged as stale on the freshness panel | Only enabled sources can be stale |
| Medium (config) | Docker Compose did not pass AI settings to the worker (since Milestone 3), so a Compose deployment would have analysed with the baseline even with a key | Worker receives AI and notification settings |

## Defects found during Milestone 5 (all fixed, with regression tests)
| Severity | Defect | Fix |
|---|---|---|
| High (found in testing) | Aggregate-currency and cache validity relied only on maxima of write-time columns, so deletions were invisible to them; the report consistency check failed a report instead of rendering a wrong timeline | Aggregate timelines are cross-checked against base totals and fall back; cache also keyed by data version; fixtures now use write-time timestamps as production does |
| Medium | Cached responses never hit: the stored data stamp was compared as a JSON string, but jsonb reorders keys | Field-by-field comparison |
| Medium | Scheduled runs took `queued_at` from the DB clock while the sweep used the injected clock (with a skewed clock, a fresh run could be cancelled as "not started") | Same clock for both |
| Medium | Refresh insert failed (`$1` typed as text into a uuid column) | Explicit cast |
| Low | PDF cover note overflowed onto an extra page and displaced footers | Note placed inside the margin without auto page break |
| Low | Engine limitations were English inside Indonesian reports | Coded, bilingual limitation messages |
| Low | Dashboard default `to = now` made every request a cache miss | Default end rounded up to the next minute |
| Low | `dump.rdb` (Redis snapshot) had been committed since Milestone 4 | Removed and ignored |

## Security risks (open)
1. **RLS context is set by the application.** An attacker with arbitrary SQL execution as the app role can set
   `app.tenant_id`/`app.system` and read any tenant. RLS guards against logic bugs, not SQL injection.
   Mitigations: parameterised queries only (no SQL string building with input), column grants, and no TEMP.
   Recommended later: per-request signed context or a separate role for system flows.
2. Local identity adapter in use (no MFA). An MFA-capable IdP is required before government production use.
3. Per-account lockout can be triggered by an attacker against a known email (bounded to 15 minutes).
4. **AI provider data flow:** when a key is configured, permitted source text (headline/excerpt/body) and project category names are
   sent to the provider. No account data or analyst input is sent. Prompt injection is contained by the evidence check (output can only
   cite text that exists in the source) and by AI output having no access to tools, the database or authorization decisions. Untested
   against a live model.
5. **System-context scans for scheduling:** `alert_rules`, `notification_deliveries`, `webhook_deliveries`, `report_schedules`, `report_runs`, `report_artifacts` and `analytics_state` have a read-only policy for
   the system context so the scheduler can find due work. Combined with risk 1, an attacker with SQL execution could read them.
6. **Webhook payloads leave the platform** (issue title, counts, source links) to tenant-verified HTTPS endpoints; tenants control those endpoints.
7. **Report artifacts are stored in PostgreSQL (bytea)** until expiry. Backups contain them; backup retention must match the
   report retention policy. Moving them to object storage with server-side encryption is recommended at scale.
8. The full list with severities and acceptance criteria is in PRODUCTION_READINESS_ASSESSMENT.md §2.2.

## Data-source and licensing risks
- **No source has been legally reviewed.** The two live RSS sources are registered "for limited integration test only", with a basis
  that says so, and store headline, link and publication time only. Scheduled collection is left disabled for them.
- Fetching a publicly offered RSS feed does not grant redistribution rights. The product stores licence terms per source and snapshots
  them per record, but **deciding** what is permitted is a legal task.
- Both real feeds embed full article text (`content:encoded`); it is discarded unless the source is marked `permitsFullText`.
- GDELT's terms permit unrestricted use with citation, but its rate limits make it unsuitable as a primary source at volume.
- Source retention periods are enforced by deletion once a tenant enables retention.

## Required external credentials
Managed IdP · email provider (SMTP: `SMTP_URL`, `EMAIL_FROM`) · WhatsApp Business Cloud API (optional) · Redis (required for collection and analysis) · `ANTHROPIC_API_KEY` (for AI-model analysis; baseline otherwise) · `CREDENTIALS_KEY` (webhook signing secrets; credentialed connectors) · a licensed news provider or publisher API contract (for a commercial second connector) · written source authorizations.

## Defects found during production hardening (all fixed)
See PRODUCTION_READINESS_ASSESSMENT.md §2.1 for the full list.
The most serious:
- authorization and visibility leaks F1–F3;
- a restore path that widened app-role privileges (R-1);
- retention never enforced (G1);
- quadratic HTML stripping (M2);
- slow deep-page mention search (M11);
- fixable HIGH/CRITICAL CVEs in the runtime images (M13).

## Test results (2026-10-20, after the social listening engine)
| Command | Result |
|---|---|
| `npm run lint`, `npm run typecheck` (API + web) | ✔ |
| API jest (Postgres 16 + Redis 7) | **509 passed, 0 failed** (29 suites; +27 social unit, +12 social e2e against a mock YouTube API, +1 config) |
| web `node:test` | 16 passed |
| `npm run build` (API + web) | ✔ (route `/o/[orgId]/social`) |
| `npm audit --omit=dev` | 0 vulnerabilities |
| Licence review / secret scan (tree + history) | 201 packages pass / 0 findings |
| Migration 0012 on the dev DB | applied |
| Browser smoke (dev DB, real API) | social workspace: create connector, details, provider matrix, analytics empty state, budgets; no console errors. The three smoke-test connectors were deleted afterwards. |
| Live YouTube | **not run**: no API key. Unauthenticated probe: HTTP 403 `forbidden` (reachable; error envelope as parsed) |

Defects found by the new tests and fixed before commit:
- the quota and budget pre-flight rolled back its own pause;
- comment text was counted twice;
- DATE columns broke the usage and cost endpoints (500);
- URL fragments were treated as hashtags.

## Test results (2026-10-20, after production hardening)
| Command | Result |
|---|---|
| `npm run lint`, `npm run typecheck` (API + web) | ✔ |
| API jest (Postgres 16 + Redis 7) | **469 passed, 0 failed, 0 skipped** (27 suites; up from 423) |
| web `node:test` | 12 passed |
| `npm run build` (API + web) | ✔ |
| `npm audit --omit=dev` | 0 vulnerabilities (all dependencies: 39 in dev tooling, see SUPPLY_CHAIN.md) |
| `node scripts/check-licenses.mjs` | 201 production packages, pass (2 reviewed exceptions) |
| `node scripts/scan-secrets.mjs --history` | 0 findings |
| Restore drill (dev DB, PG16) | 6/6 checks incl. 94-object privilege comparison; negative test fails as expected |
| Migrations on the dev DB | 0010 and 0011 applied; 4 audit chains (82 events) verify |
| Images | api and web build; Trivy 0 fixable HIGH/CRITICAL; containers smoke-tested |
| Load test | LOAD_TESTING.md (single 4-vCPU host; no capacity claim) |

## Test results (2026-10-20, after Milestone 5)
| Command | Result |
|---|---|
| `npm run lint`, `npm run typecheck` (API + web) | ✔ |
| API jest (Postgres 16 + Redis 7) | **423 passed, 0 failed, 0 skipped**; two consecutive runs green |
| web `node:test` | 12 passed |
| `npm run build` (API + web) | ✔ |
| `npm audit --omit=dev` | 0 vulnerabilities |
| Migration 0009 on the dev DB | applied; placeholder report tables were empty; 211 real records preserved; 57/57 tables with forced RLS |
| Live run | aggregates built; all analytics endpoints on real data; 8 reports (all five templates, both languages) generated, PDF/CSV downloaded and inspected |
| Browser smoke (live data) | executive dashboard (tooltip, table view, custom-period + project filter), reports (generate, history, run preview, PDF download): no console errors |

## Test results (2026-10-19, after Milestone 4)
| Command | Result |
|---|---|
| `npm run lint`, `npm run typecheck` (API + web) | ✔ |
| API jest (Postgres 16 + Redis 7) | **366 passed, 0 failed, 0 skipped**; three consecutive runs green |
| web `node:test` | 9 passed |
| `npm run build` (API + web) | ✔ |
| `npm audit --omit=dev` | 0 vulnerabilities |
| Migration 0008 on the dev DB | applied; placeholder tables were empty; 153 + 58 real records preserved; 50/50 tables with forced RLS |
| Live run | 58 records collected and analysed; 6 rules evaluated; 1 issue; in-app + email (local sink) delivered |
| Browser smoke (live data) | dashboard (incl. chart tooltip), issue detail (acknowledge + note via UI), rules (dry run, form), notifications, admin: no console errors |

## Test results (2026-10-19, after Milestone 3)
| Command | Result |
|---|---|
| `npm run lint`, `npm run typecheck` (API + web) | ✔ |
| API jest (`TEST_REDIS_URL=redis://localhost:6379/15`) | **304 passed, 0 failed, 0 skipped**; three consecutive runs green |
| web `node:test` | 6 passed |
| `npm run build` (API + web) | ✔ |
| `npm audit --omit=dev` | 0 vulnerabilities |
| Migration 0007 on the existing dev DB | applied; 153 mentions and all users/projects preserved; 38/38 tables with forced RLS |
| `npm run eval:ai` | see AI_EVALUATION.md |
| Browser smoke (Playwright, live dev data) | Analytics, Stories, story detail, Mentions, mention detail, project, admin: rendered, no console errors |

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
**Social: live verification and second provider.**
1. Obtain a YouTube Data API key in a customer- or operator-owned Google Cloud project. In staging: test the connection, sync,
   confirm header authentication, compare counts with YouTube, exercise one lifecycle refresh, then mark the connector live-verified.
2. Decide on the derived-metrics amendment for AI analysis of YouTube data.
3. Legal review of social comments as personal data, and of legal hold vs provider deletion duties.
4. Evaluate X API (Developer Agreement, deletion compliance, pay-per-use budget) or a licensed aggregator for Facebook, Instagram
   and TikTok coverage, before building a second connector.

**Still blocking production** (PRODUCTION_READINESS_ASSESSMENT.md): an OIDC identity provider with enforced MFA, staging with
PITR, an external penetration test, and legal review.


## Prompt 08: commercialization, subscriptions and billing
Implemented: see [BILLING_AND_SUBSCRIPTIONS.md](BILLING_AND_SUBSCRIPTIONS.md) and [USAGE_METERING.md](USAGE_METERING.md).
- Configurable, versioned plans (seeded **without prices**); features separate from quotas; per-tenant overrides with reasons.
- A server-side subscription state machine with history, plus scheduler jobs for:
  - trial expiry, past-due grace and suspension;
  - scheduled changes, period renewal, contract terms and overdue invoices.
- An idempotent, append-only usage ledger with period and daily aggregates, corrections and reconciliation.
- Hard and soft quotas enforced in API routes and workers under concurrency. Threshold notices at 70/85/95/100 %.
- Contract and manual invoicing with payment reconciliation. Invoices are labelled "not a Faktur Pajak".
- A payment-provider interface with `none` (default) and a `test` simulator, refused in production. Webhooks are signature-verified, replay-safe and logged.
- A customer billing page, persistent onboarding (`/o/:id/getting-started`), and the platform console (`/platform`) for plans, organizations, contracts, invoices, costs and margin, health, sales requests and the commercial audit.

**Not implemented:**
- a live payment provider;
- tax invoices (e-Faktur);
- a public API (`api_access`);
- proration;
- automatic enforcement of plan retention limits.

## Prompt 09: full-system QA and regression audit (2026-10-20)

The full report is in [FULL_SYSTEM_QA_REPORT.md](FULL_SYSTEM_QA_REPORT.md).

- **Audit scope:** six parallel module audits (authorization, ingestion and social, AI, alerts/analytics/reports, billing, frontend contracts), plus an end-to-end lifecycle integration test.
- **Findings:** no P0. No cross-tenant leak found. 12 P1 and 35 P2 defects.
- **Fixed:** all 12 P1s and 25 of the 35 P2s, each with a regression test. Migration `0014_qa_fixes.sql` provides:
  - checkout sessions;
  - cache-write token pricing;
  - append-only payments and immutable issued invoices;
  - a frozen usage time zone;
  - delivery claim columns;
  - purge indexes.
- **Open P2s:**
  - AI: AI-06 (cluster summaries bypass the rate gate), AI-07 (stale cluster summary overwrite), AI-10, AI-11 and AI-12 (clustering and language detection);
  - IN-04: an updated article at the same URL is not re-processed;
  - AR-04 (syndicated copies counted), AR-06 (notification daily budget), AR-08 (issues dashboard UTC days);
  - FE-02: social connector edit UI.
- **Tests:** 34 API suites / 577 tests, web 20/20, lint, typecheck and build all pass. Secret, licence and production dependency scans are clean.
- **Verdict:** ready for **controlled internal testing**. Not ready for a pilot until the conditions in the QA report, section 13, are met (above all, live verification of the LLM, SMTP and staging environment).

## Prompt 10: pilot deployment and production operations (2026-10-21)

Audit and gap list: [PILOT_DEPLOYMENT_AUDIT.md](PILOT_DEPLOYMENT_AUDIT.md). **No staging or production environment exists; nothing was deployed.**

**Implemented and verified locally** (production Compose stack in this container, `scripts/stack-test.sh`):
- **Startup validation:** stricter rules for staging and production. Required `CREDENTIALS_KEY`, `METRICS_TOKEN` and SMTP; numeric settings checked; `DATABASE_POOL_MAX`.
- **Staging sandbox:** recipient allow-lists for email, webhooks and WhatsApp; billing simulator allowed in staging only.
- **Production Compose stack:** `infra/compose.production.yml`, with a TLS edge (`Caddyfile.production`), hardened containers, internal networks, a one-shot migrate job and an optional self-hosted data profile.
- **Images:** base pinned by digest; uid 1000; exec-form health checks.
- **Web probes:** `/healthz` and `/readyz` on the web app. This fixes the deploy workflow's readiness check, which could never pass.
- **Scripts:**
  - `scripts/smoke.mjs` (read-only post-deploy smoke test);
  - `scripts/stack-test.sh` (CI job `stack`);
  - `scripts/check-migrations.mjs` with `db/migrations.lock`, run in CI.
- **Deploy workflow:** production requires a successful staging deployment of the same SHA and a configurable protected release branch; the smoke test runs after readiness.
- **Monitoring:** new gauges for the DB pool, ingestion runs, billing webhooks and social quota; a backup textfile metric; 23 alert rules (`infra/monitoring/alerts.yml`).
- **Two backup defects fixed:**
  - the restore drill reset the live app-role password;
  - encrypted restores failed.
- **Runbooks:** DEPLOYMENT.md (rewritten), DISASTER_RECOVERY_RUNBOOK.md, INCIDENT_RESPONSE_RUNBOOK.md, PILOT_OPERATIONS_RUNBOOK.md.

**Results:**
- 34 API suites / 590 tests, web 20/20, lint, typecheck and build pass;
- secret scan, licences, `npm audit` (prod), shellcheck, hadolint, promtool and caddy validate are clean;
- the stack test passed.

**Not verified:**
- **Real Dockerfile builds in this container.** There is no npm registry access from build containers; CI builds them.
- Any remote deployment, registry push, DNS or TLS on a real domain, managed database or PITR, SMTP relay, AI key or monitoring stack.

**Owner actions before staging:**
- create and protect a release branch (the remote has no `main`);
- make the repository private;
- choose hosting;
- create the GitHub environments, the deployment agent, secrets, domain, SMTP and monitoring.
