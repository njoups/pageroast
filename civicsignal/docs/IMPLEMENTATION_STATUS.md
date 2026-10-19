# Implementation Status

Last verified: 2026-10-19, from code, test runs and live collection (not from plans). Commands and results are at the bottom.

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

## Partially implemented
- **GDELT connector:** implemented and contract-tested. **Not verified live**: every attempt from this environment returned
  429/503 (shared egress IP). Health shows it honestly as failing.
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
- **Analytics page** (Milestone 3) still computes on read; the alert dashboard uses the new aggregates.
- **Summaries on headline-only sources:** live sources permit headlines only, so mention summaries are mostly "insufficient evidence"
  and cluster/project summaries are extractive (quotes and counts).
- **Retention:** expiry is computed per record, but nothing deletes expired records yet (Milestone 6).
- **Identity:** local adapter only (no MFA, no password reset, no email verification).
- **Rate limiting of login:** in-process memory per API instance (ingestion gates are in Redis).
- **Client IP** is trustworthy only behind an edge proxy that overwrites `X-Forwarded-For` (Caddy in Compose).
- **Docker Compose** (now with Redis + worker) validates, but images and stack have **not** been run (no Docker daemon available).
- **Conditional GET:** a 304 has been verified only against the local test server. Live feeds changed every minute or sent no ETag.

## Missing
Reports, entity/summary/clustering quality evaluation, analyst annotations (UI area reserved; no storage yet), billing/metering enforcement, retention jobs,
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

## Security risks (open)
1. **RLS context is set by the application.** An attacker with arbitrary SQL execution as the app role can set
   `app.tenant_id`/`app.system` and read any tenant. RLS guards against logic bugs, not SQL injection.
   Mitigations: parameterised queries only (no SQL string building with input), column grants, and no TEMP.
   Recommended later: per-request signed context or a separate role for system flows.
2. Local identity adapter in use (no MFA). Required before government production use.
3. Per-account lockout can be triggered by an attacker against a known email (bounded to 15 minutes).
4. **AI provider data flow:** when a key is configured, permitted source text (headline/excerpt/body) and project category names are
   sent to the provider. No account data or analyst input is sent. Prompt injection is contained by the evidence check (output can only
   cite text that exists in the source) and by AI output having no access to tools, the database or authorization decisions. Untested
   against a live model.
5. **System-context scans for scheduling:** `alert_rules`, `notification_deliveries` and `webhook_deliveries` have a read-only policy for
   the system context so the scheduler can find due work. Combined with risk 1, an attacker with SQL execution could read them.
6. **Webhook payloads leave the platform** (issue title, counts, source links) to tenant-verified HTTPS endpoints; tenants control those endpoints.

## Data-source and licensing risks
- **No source has been legally reviewed.** The two live RSS sources are registered "for limited integration test only", with a basis
  that says so, and store headline, link and publication time only. Scheduled collection is left disabled for them.
- Fetching a publicly offered RSS feed does not grant redistribution rights. The product stores licence terms per source and snapshots
  them per record, but **deciding** what is permitted is a legal task.
- Both real feeds embed full article text (`content:encoded`); it is discarded unless the source is marked `permitsFullText`.
- GDELT's terms permit unrestricted use with citation, but its rate limits make it unsuitable as a primary source at volume.
- Retention periods are recorded but not yet enforced by deletion.

## Required external credentials
Managed IdP · email provider (SMTP: `SMTP_URL`, `EMAIL_FROM`) · WhatsApp Business Cloud API (optional) · Redis (required for collection and analysis) · `ANTHROPIC_API_KEY` (for AI-model analysis; baseline otherwise) · `CREDENTIALS_KEY` (webhook signing secrets; credentialed connectors) · a licensed news provider or publisher API contract (for a commercial second connector) · written source authorizations.

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
**Milestone 5, reporting:** source-backed PDF/CSV reports (issue briefs from the persisted evidence, periodic coverage reports from the
aggregates), scheduling and history, reusing the issue evidence and severity breakdowns. Before relying on tone-based alerts in
production, configure and evaluate an AI model (`npm run eval:ai -- --llm`). Configure a real email provider and run one delivery
through it. Still recommended: legal review of publisher terms and a licensed full-text source.
