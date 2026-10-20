# Full-System QA Report (Prompt 09)

Date: 2026-10-20. Scope: the whole `civicsignal/` monorepo on branch `claude/youthful-darwin-rk5mhl`: API (NestJS), worker, web (Next.js), migrations 0001–0014.
Environment: one disposable development container (4 vCPU, 15.7 GB RAM, PostgreSQL 16, Redis 7, Node 22). **There is no staging or production environment.** No live social-platform credentials, no live LLM key and no live payment provider were used.

This report covers only what was run and observed. A passing test suite shows that the tested behaviour works in this container. It is **not** a security certification, a compliance claim or evidence of production capacity.

---

## 1. Executive summary

- **Method.**
  - Recorded a baseline (lint, typecheck, all tests, build, secret, licence and dependency scans).
  - Inventoried the system: 12 controllers, 219 routes, 31 web pages, 83 tables and 8 worker schedulers.
  - Ran six parallel code audits: authorization and tenancy, ingestion and social, AI, alerts/analytics/reports, billing and commercial, frontend contracts.
  - Wrote an end-to-end lifecycle integration test.
  - Fixed confirmed defects in priority order, each with a regression test.
  - Ran a synthetic load test.
- **Findings.**
  - No P0 was found.
  - No cross-tenant read or write was found: RLS, route guards and the cross-tenant test matrix all held.
  - There were **12 P1 defects** (AI grounding and metering, duplicate notifications, billing state) plus 35 P2 defects and many P3s.
- **Fixed.**
  - All 12 P1s.
  - 25 of the 35 P2s.
  - Several P3s that came free with those fixes.
  - Migration `0014_qa_fixes.sql` adds the schema support those fixes need.
- **Still open.** 10 P2s and the remaining P3s are listed in section 11. None of them is a tenant-isolation, authentication or payment-integrity defect.
- **Verdict.** **Ready for controlled internal testing.** Not yet ready for a limited pilot until the conditions in section 13 are met. Main reasons:
  - The external integrations have never run against the real services: the LLM, YouTube, the payment provider and SMTP relays.
  - The open P2s affect analytics accuracy and the social connector UI.

## 2. Verification matrix

Legend:

| Label | Meaning |
|---|---|
| **Verified** | Implemented, and checked by automated tests and/or a live run in this container |
| **Not fully verified** | Implemented and partly tested |
| **Partial** | Some of the feature exists |
| **Mocked** | Runs only against a simulated or mock dependency |
| **Missing** | Not implemented |
| **Blocked** | Needs credentials or an external account we do not have |

| Area | Feature | Status | Evidence |
|---|---|---|---|
| A. Auth | Register, login, logout, sessions, idle timeout, password reset (token), session revocation | Verified | `auth*.e2e.ts`, `security.e2e.ts` |
| A. Auth | Email verification on register | Missing | AZ-05 (P3) |
| A. Auth | SSO / external IdP | Missing | Only the local identity provider exists |
| B. Tenancy | Forced RLS on every tenant table; `withTenant`/`withSystem` GUCs | Verified | `test/db/*`, cross-tenant matrix in `security.e2e.ts`, lifecycle test |
| B. Tenancy | Role permissions (owner/admin/PM/analyst/report_viewer) | Verified | `permissions.spec.ts`. Two gaps fixed here (AZ-01, AZ-02) |
| C. Ingestion | RSS/Atom collection, SSRF-safe fetch, canonical URL, dedup, matching | Verified | `safe-http.spec.ts`, ingestion e2e, lifecycle test, live collection earlier (Prompt 02) |
| C. Ingestion | Updated article at the same URL re-processed | Missing | IN-04 (P2, open) |
| C. Social | YouTube connector, quota budgets, lifecycle | Mocked / Blocked | Mock provider only. No YouTube API key |
| D. AI | Baseline analyser (no LLM) | Verified | AI unit and e2e tests, lifecycle test |
| D. AI | Anthropic adapter, grounding guards, cost metering | Mocked / Blocked | Adapter tested with a fake transport. No live key |
| D. AI | Cluster summaries | Not fully verified | AI-06 and AI-07 (P2) open |
| E. Alerting | Rules, detection, severity, issue dedup, in-app/email/webhook delivery | Verified | `alerts.e2e.ts` (local SMTP sink), detection unit tests. Double delivery fixed (AR-01) |
| E. Alerting | Real SMTP relay / real webhook receivers | Blocked | Local sink only |
| F. Analytics / reports | Metrics, CSV/PDF reports, scheduled reports | Verified | analytics and reports e2e, lifecycle test |
| F. Analytics | Syndicated-copy exclusion as documented | Partial | AR-04 (P2, open) |
| G. Social analytics | Channel filters, social workspace | Mocked | Mock provider data |
| H. Billing | Plans, entitlements, quotas, metering, invoices, manual payments, lifecycle scheduler | Verified | `commercial.e2e.ts`, `qa-regressions.e2e.ts`, commercial unit tests |
| H. Billing | Self-service checkout and webhooks | Mocked | `test` provider with HMAC signatures. **No live payment provider** |
| I. Admin / governance | Platform console, retention, legal hold, deletion requests, audit hash chain | Verified | governance and commercial e2e, `security.e2e.ts` |
| I. Ops | Backup and restore drill, health and readiness, metrics | Verified | Drill script (Prompt 06), health tests |
| I. Ops | Deployment to real infrastructure | Missing | Deploy workflow exists but has never run against an environment |

## 3. Baseline (before Prompt 09 changes, commit `f3070c0`)

| Check | Result |
|---|---|
| `npm run lint` | exit 0 |
| `npm run typecheck` | exit 0 |
| API tests (jest) | 31 suites, 545 tests, all passed |
| Web tests (node:test) | 20/20 passed |
| `npm run build` | exit 0 |
| `npm audit --omit=dev --audit-level=high` | 0 vulnerabilities |
| `npm audit` (incl. dev) | 39 (7 moderate, 32 high), all in jest/tailwind dev tooling. Fixes need major bumps |
| `node scripts/scan-secrets.mjs --history` | 319 files, 0 findings |
| `node scripts/check-licenses.mjs` | exit 0 |
| trivy / semgrep / gitleaks / osv-scanner | Not installed in this container (trivy runs in CI) |

A green baseline still hid 12 P1 defects. It was a starting point, not a quality signal.

## 4. Defects found

Severity scale:

- **P0:** data loss, a cross-tenant leak or an auth bypass.
- **P1:** wrong money, duplicate external sends, or invented content presented as evidence.
- **P2:** wrong results or an integrity gap with a workaround.
- **P3:** minor.

IDs are prefixed by area: AI, IN = ingestion/social, BL = billing, AR = alerts/analytics/reports, AZ = authorization, FE = frontend.

**P1 (12, all fixed)**

| ID | Defect |
|---|---|
| AI-01 | Evidence check accepted 2-letter fragments and sub-word matches, so invented entities and quotes passed as "grounded" |
| AI-02 | Model-supplied aliases could merge unrelated entities (alias poisoning) |
| AI-03 | Multi-record summaries could state numbers and quotations found in none of the cited records |
| AI-04 | Tokens spent on failed, refused or rolled-back calls were never metered |
| IN-01 | YouTube monthly budget pause ended at the UTC month, not the provider's Pacific month, so pauses chained |
| BL-01 | A paid checkout could not reactivate an organization whose trial had expired |
| BL-02 | Provider invoice events for an old subscription were applied to the current one |
| BL-03 | A paid invoice lifted an operator or abuse suspension |
| BL-04 | Out-of-order events could downgrade a paid invoice |
| BL-05 | A stale `contract_id` expired a non-contract subscription |
| BL-06 | Usage reconciliation could lose usage recorded concurrently (lost update) |
| AR-01 | Email and webhook notifications could be sent twice (no atomic claim; retries re-sent) |

**P2 (35).**

- **Fixed (25):**
  - AI-05, AI-08, AI-09, AI-13;
  - IN-02, IN-03, IN-05, IN-06;
  - BL-07 to BL-17;
  - AR-02, AR-03, AR-05, AR-07/AZ-02;
  - AZ-01;
  - FE-01.
- **Open (10):** AI-06, AI-07, AI-10, AI-11, AI-12, IN-04, AR-04, AR-06, AR-08, FE-02 (see section 11).

**P3.**

- **Fixed:** IN-07, IN-10, IN-13, AR-12, AZ-06, AI-14a, and the BL provider-reference index.
- **Open:** see section 11.

## 5. Fixes implemented

| ID | Fix | Where |
|---|---|---|
| AI-01 | Whole-word, normalized `occursIn()` with a minimum length. Entities, aliases and quotes must occur in the source. A source_fact claim's numbers must appear in its quote. Interpretations may not add numbers. A summary with no source_fact is `insufficient_evidence` | `analysis/schemas.ts` |
| AI-02 | Aliases kept only if present in the source. An alias equal to another entity's name is never attached | `schemas.ts`, `analysis.service.ts` |
| AI-03 | `sanitizeMultiSummary` grounds every claim and conflict against the texts of the records it cites. Ungrounded headlines are dropped and text is capped | `schemas.ts`, `summaries.service.ts`, `issue-summary.service.ts` |
| AI-04 | Usage recorded in its own transaction right after the provider call, and from errors that carry usage (refusal, truncation, invalid output) | `analysis.service.ts`, `anthropic.provider.ts`, `provider.ts` |
| AI-05 | Cost = input + cache-read + cache-write + output, each at its own price, with no subtraction. Cache-write tokens are stored | `analysis/usage.ts`, migration 0014 |
| AI-08 / AI-09 | A late, older analysis no longer replaces a newer one. A reclaimed claim records its own `started_at` | `analysis.service.ts` |
| AI-13 | Escapes the delimiter in source text even without a closing `>` | `analysis/prompts.ts` |
| IN-01 | Budget period end = the provider's next month (Pacific time for YouTube) | `social/quota.ts` |
| IN-02 / IN-07 | Redirects: invalid `Location` is a non-retryable error; https→http is refused; credential headers are dropped on an origin change | `ingestion/safe-http.ts` |
| IN-03 | Duplicate detection only within 36 h of publication. An empty (emoji-only) normalized title never matches by hash | `ingestion/dedup.ts`, `pipeline.service.ts` |
| IN-05 | Changing a source's feed host resets it to `unverified` unless re-authorized with a basis. Audited | `ingestion/sources.service.ts` |
| IN-06 / IN-10 | Query limits: max 20 prefix terms and a NOT-depth check. Binary-search term lookup. Rematch yields every 200 documents | `ingestion/query.ts`, `pipeline.service.ts` |
| IN-13 | Canonical URLs drop the username and password | `ingestion/url.ts` |
| BL-01 | `checkout_sessions` table. `checkout.completed` must match a known session and then reactivates through assignment | `commercial/webhooks.ts`, `billing-api.ts`, 0014 |
| BL-02 / BL-13 | Invoice events act only when the subscription's provider reference matches. Unknown references are retryable (not silently dropped) | `webhooks.ts` |
| BL-03 | Payment recovery lifts only a `past_due_grace_elapsed` suspension | `webhooks.ts` |
| BL-04 | A paid invoice is never downgraded. Totals come from the paid event. Billing periods only move forward | `webhooks.ts` |
| BL-05 / BL-17 | Plan assignment keeps `contract_id` only for contract billing and provider references only for self-service. BL-17 only partly: operator assignment still sets a status directly instead of going through the state machine (audited in `subscription_events`) | `subscriptions.ts` |
| BL-06 | Advisory lock per tenant: shared for consume, exclusive for reconcile and correction | `commercial/quota.ts` |
| BL-07 / BL-08 / BL-09 | Money in SQL `numeric` with 2-dp validation. Partial payment past due stays `overdue`. Voiding the last overdue invoice triggers recovery. Overpayment refused | `commercial/invoices.ts` |
| BL-10 | Usage period time zone frozen with the anchor (`subscriptions.usage_timezone` and a trigger) | `quota.ts`, 0014 |
| BL-11 | Corrections take an idempotency key and cannot correct below zero in total | `quota.ts`, `platform-commercial.ts` |
| BL-12 | Notice emails claimed atomically, failures isolated per email, sent only to enabled users | `commercial/scheduler.ts`, 0014 |
| BL-14 | Renewing a contract requires and records a new end date | `platform-commercial.ts` |
| BL-15 / BL-16 | Payments FK no longer blocks tenant deletion; payments are append-only (no UPDATE/DELETE grant). Indexes added for the purge cascades. Issued manual invoices are immutable | 0014 |
| AR-01 / AR-05 / AR-12 | Email and webhook deliveries are claimed atomically (`sending`, `claimed_at`), stale claims are reclaimed, eligibility is re-checked (disabled or removed users are suppressed), and permanent failures become `dead` | `alerts/notifications.service.ts`, `alerts-queue.ts`, 0014 |
| AR-02 | Negative-shift severity scores the negative share of the window's confident population, not of the negative-only evidence (previously always 100%) | `alerts/severity.ts` |
| AR-03 | Date-only analytics bounds are tenant-local calendar days, and a date-only `to` includes that whole day | `analytics/engine.ts` |
| AZ-01 | Enabling retention, adding or shortening a policy, and lifting a legal hold require `data:delete` (owner) | `governance/governance-api.ts` |
| AZ-02 / AR-07 | CSV export requires `data:export` (report_viewer can no longer export) | `reports/reports-api.ts` |
| FE-01 | `auth/me` returns each organization's display settings (time zone, brand colour only), so the UI formats dates in the tenant zone | `auth/auth.controller.ts` |

## 6. Regression tests added

| File | Tests | Covers |
|---|---|---|
| `test/integration/lifecycle.e2e.ts` (new) | 6 | Feed → collection → dedup/canonical → analysis → cluster → analytics → keyword alert and notification → CSV report → usage → billing. Cross-tenant invisibility at each step. report_viewer CSV → 403 |
| `test/unit/qa-regressions.spec.ts` (new) | 13 | AI-01/02/03, IN-01, IN-13, BL-10, AR-02, AR-03, IN-03 |
| `test/integration/qa-regressions.e2e.ts` (new) | 10 | BL-01, 02/05, 03/04, 06, 07/08/09, 10, 11, 14, AZ-01, FE-01 |
| `test/integration/safe-http.spec.ts` | +2 | IN-02, IN-07 |
| `test/integration/alerts.e2e.ts` | +1, 1 changed | AR-01 (fails on the old code with 3 sends; passes with 1). Permanent SMTP rejection now expects `dead` |
| `test/unit/analysis/anthropic-adapter.spec.ts`, `guards.spec.ts` | changed | Cache-write tokens, `truncated` kind, usage on errors, delimiter escape |
| `test/integration/commercial.e2e.ts` | 2 changed | Partial payment past due → `overdue`. Unknown checkout session → retryable failure |

**Changed expectations.** Seven existing assertions were changed, and each one encoded the old defective behaviour:

- error kind `truncated` (was `invalid_output`);
- cache-write tokens counted;
- escaped delimiter form;
- `dead` status for permanent SMTP failure;
- `overdue` after a partial late payment;
- retryable unknown checkout session;
- the commercial unit helper's `periodTimezone`.

No assertion was loosened and no test was skipped. AR-01 and AR-02 were also run against the old code and fail there as expected.

## 7. Security testing

- **Tenant isolation.**
  - Forced RLS covers all 83 tables: the migration test asserts that every table with `tenant_id` has RLS enabled and forced.
  - The cross-tenant matrix in `security.e2e.ts` and the lifecycle test (which re-checks each artifact from a second tenant) both pass.
  - No leak was found.
- **Route guards.** All 219 routes were enumerated. Each one is either public by design (health, login, register, signed webhooks) or session-guarded and permission-checked. Two permission gaps were found and fixed (AZ-01, AZ-02).
- **SSRF.**
  - The safe fetcher's IP policy (private, loopback, link-local and metadata ranges) and DNS-rebinding protection (resolve → pin → connect) are covered by `safe-http.spec.ts` against local listeners only.
  - Redirect handling was hardened (IN-02, IN-07).
  - **No real internal service or cloud metadata endpoint was contacted.** Tests use loopback listeners with `INGESTION_ALLOW_PRIVATE_HOSTS` off.
- **Injection.**
  - SQL is parameterized throughout (audited). The query language has hard limits (IN-06, IN-10).
  - CSV formula injection is neutralized (tested).
  - The LLM prompt delimiter is escaped (AI-13).
- **Webhooks.** HMAC signature, timestamp tolerance and replay idempotency are tested. Unknown references are now retried rather than dropped.
- **Abuse and quota.** Hard quotas, rate limits (Redis) and idempotent consumption are tested.
- **Open security-relevant items (P3):**
  - AZ-03: inbox/deferred deliveries are not re-checked against project access at read time.
  - AZ-04: cookie fallback without the `__Host-` prefix if `COOKIE_SECURE` is misconfigured.
  - AZ-05: no email verification, and register reveals existing accounts.
  - AZ-07: system-read policies expose content columns to `withSystem` paths.
  - AZ-08: social parent-post title visible through analytics.
  - AZ-09: cluster uncertainty notes.
- **Scans after the changes.** See section 12.

## 8. Data integrity and migrations

- Migration `0014_qa_fixes.sql` was applied:
  - to fresh disposable test databases (every test run creates and migrates one);
  - to the disposable load database;
  - as an upgrade of the development database from 0012 to 0014.
- Checksums are enforced by the migration runner.
- **No user data was deleted or reset.** The development database was upgraded in place. Destructive tests ran only in disposable databases.
- **New integrity guarantees:**
  - payments are append-only;
  - issued manual invoices and their lines are immutable (triggers);
  - money is exact `numeric`;
  - the usage period time zone is frozen;
  - checkout sessions are recorded;
  - usage is serialized against reconciliation;
  - indexes now cover the purge and FK paths (`alert_evidence`, `report_run_sources`, `cluster_members`, `ai_summaries`).
- **Open:**
  - IN-04: an article updated at the same URL is not re-processed.
  - AI-10: re-analysis can dissolve a 2-member cluster.
  - AZ-10 / BL: single-column FKs on some tenant tables (cross-tenant references are prevented by RLS, not by composite keys).

## 9. Performance (synthetic data)

Synthetic data only: 3 tenants × 20,000 mentions (61,200 records after earlier ingestion runs) in the disposable database `civicsignal_load`. The API, worker, PostgreSQL and the load generator all shared one 4-vCPU container (Xeon 2.8 GHz), with no TLS and no network between tiers. Scripts: `scripts/load/seed.mjs` and `scripts/load/run.mjs`. Raw output: `docs/load-results/2026-10-20-qa-foreground.jsonl` and `docs/load-results/2026-10-20-qa-background.json`.

Run on the fixed build (commit `132a5a1`, migration 0014), 30-second closed loops, 0 errors in every scenario:

| Scenario | Conc. | Req/s | p50 ms | p95 ms | p99 ms | Previous run (LOAD_TESTING.md): req/s, p95 |
|---|---|---|---|---|---|---|
| auth.login | 4 | 28.9 | 134 | 169 | 208 | 38.5, 124 |
| search | 16 | 106.2 | 148 | 208 | 237 | 167.9, 132 |
| analytics | 16 | 249.9 | 46 | 70 | 709 | 335.1, 54 |
| alerts | 16 | 468.2 | 33 | 52 | 62 | 535.9, 45 |
| mixed (3 tenants) | 32 | 177.3 | 140 | 420 | 1,173 | 252.0, 161 |

| Background scenario | Outcome | p50 | p95 |
|---|---|---|---|
| reports.generate (9 weekly reports) | 9 succeeded | 5.6 s | 7.5 s |
| ingestion.collect (6 feeds × 200 items) | 6 succeeded, 1,200 records inserted | 4.8 s | 5.6 s |
| ai.baseline-backfill (829 records queued) | Queue drained in 9.5 s (≈ 87 records/s), 0 remaining | — | — |

How to read these numbers:

- **Throughput is lower than the earlier run in LOAD_TESTING.md.** The two runs used different container hosts (2.1 GHz vs 2.8 GHz Xeon), so the difference has not been attributed to code. Login also dropped by about 25%, and its cost is pure scrypt CPU that these changes did not touch, which points to host variance. A same-host A/B comparison of the baseline and fixed builds was **not** done.
- **Mixed-scenario tail latency (p95 420 ms, p99 1.2 s).** This comes from the fixed 10-connection database pool queuing at concurrency 32, which is a known item in LOAD_TESTING.md.
- **The backfill rate is not comparable with the earlier run.** It covered fewer records, and those were records the earlier baseline pass had not analysed.
- **Incident during the measurement.** The first worker process crashed when the parallel test suite reset the shared `civicsignal_app` role password on the same disposable PostgreSQL cluster. The background scenarios were re-run with a fresh worker. The foreground scenarios are unaffected because they do not use the worker. An earlier run on the pre-fix build had also competed for CPU with the audit jobs, and its numbers are discarded.
- **No capacity claim is made.** See the limits in LOAD_TESTING.md. A production capacity statement requires staging-sized infrastructure and a separate load-generator host.

## 10. Not verified against real external services

| Dependency | State |
|---|---|
| Anthropic API (LLM analysis, summaries, report commentary) | Adapter tested with a fake transport. Pricing rows are configuration, not verified against current list prices. **Never called live in this repository** |
| YouTube Data API | Mock provider only. Quota costs follow the documented unit costs. Not verified live |
| Payment provider | Only the `none` and HMAC `test` providers exist. **No real payments** |
| SMTP relay | Local SMTP sink only. Deliverability, SPF/DKIM and bounce handling are untested |
| Customer webhook receivers | Local receiver only |
| RSS publishers | Live collection was verified in Prompt 02 on a small set of public feeds. Licensing basis per source is the operator's responsibility |
| Deployment platform, TLS, secrets manager | Not available; never deployed |

## 11. Remaining defects

**P0: none. P1: none known.**

**P2 (open):**

| ID | Defect | Effect | Next step |
|---|---|---|---|
| AI-06 | Cluster summaries bypass the per-tenant AI rate gate | Possible extra LLM spend | Route them through the same gate |
| AI-07 | A stale cluster summary can overwrite a newer one | An older summary is shown | Compare cluster version on write |
| AI-10 | Re-analysis can dissolve a 2-member cluster | Story grouping flickers | Keep membership until reclustering |
| AI-11 | Clustering can join stories on generic words | Over-merged stories | Stop-word and IDF weighting |
| AI-12 | Mixed Indonesian/English text detected as `und` and skipped | Some records unanalysed | Per-sentence language vote |
| IN-04 | An updated article at the same URL is not re-processed | Stale text and analysis | Content-hash change → re-analyse |
| AR-04 | Syndicated copies are counted in some metrics, contrary to the docs | Inflated counts for wire stories | Apply the syndication filter in `conds()` |
| AR-06 | Daily notification budget counts in-app/unsent rows, does not exempt critical issues, and uses the UTC day | Alerts may be throttled early | Count only sent external notifications per tenant day |
| AR-08 | Issues dashboard uses UTC days with an inclusive end | Off-by-one day at the edges | Same treatment as AR-03 |
| FE-02 | A social connector cannot be authorized or edited after creation in the UI | Must be recreated | Add an edit form (API exists) |

**P3 (open):**

- **AI:** AI-14 b–i (custom-topic collision, hard-coded summary language, issue summary without fallback, 408/409 treated as terminal, rights revocation leaving the old analysis current, caps overshoot under concurrency, syndication over-clustering).
- **IN:** IN-08, 09, 11, 12, 14, 15, 16.
- **AR:** AR-09, 10 (PDF CreationDate is not reproducible), 11, 13, 14, 15.
- **AZ:** AZ-03, 04, 05, 07, 08, 09, 10.
- **BL:**
  - usage notices only for seat gauges;
  - plan retention limits not enforced;
  - refunds are audit-only;
  - legal hold vs an already running deletion;
  - expired invitations block re-invite.
- **FE:** FE-03 to FE-17 (hard-coded badges, stale admin text, the summary button shown to report_viewer, rule save dropping the social channel, zod details not shown, missing pagination, forms resetting on failure, etc.).
- **Dev dependencies:** 39 audit advisories in jest/tailwind dev tooling. They are not in the production bundle, and the fixes need major version bumps.

## 12. Commands and results (after the fixes)

All commands were run in this container on the final working tree (with migration 0014).

| Command | Result | Baseline |
|---|---|---|
| `npm run lint` | exit 0 | exit 0 |
| `npm run typecheck` | exit 0 | exit 0 |
| `cd apps/api && TEST_ADMIN_DATABASE_URL=… TEST_REDIS_URL=redis://localhost:6379/15 npx jest` | **34 suites, 577 tests, all passed** | 31 suites, 545 |
| `cd apps/web && npm test` | 20/20 passed | 20/20 |
| `npm run build` | exit 0 | exit 0 |
| `node scripts/scan-secrets.mjs --history` | 320 files, 0 findings (29 allow-listed test fixtures) | 319 files, 0 |
| `node scripts/check-licenses.mjs` | exit 0 | exit 0 |
| `npm audit --omit=dev --audit-level=high` | 0 vulnerabilities | 0 |
| `npm audit` (incl. dev) | unchanged: 39 advisories in dev tooling | 39 |

The test databases are created and dropped per run on a disposable PostgreSQL cluster. CI runs the same commands plus trivy.

## 13. Next steps

**Before a limited pilot:**

1. Fix the open P2s, starting with the ones that make customer-visible numbers wrong (AR-04, AR-06, AR-08, IN-04), then AI-06 and AI-07, then FE-02.
2. Run the AI path against a real Anthropic key on a fixed, labelled evaluation set (`docs/AI_EVALUATION.md`) and record precision of grounded claims and cost per record.
3. Configure a real SMTP relay and test deliverability (SPF/DKIM/bounces).
4. Deploy to a staging environment with TLS, a secrets manager, backups and monitoring. Repeat the backup/restore drill and the load test there.
5. Fix AZ-04 (fail closed on a non-secure cookie in production) and AZ-05 (email verification).

**Before broader deployment:**

1. A real payment provider adapter with its own webhook contract tests.
2. YouTube connector verified with a real API key and quota.
3. An external penetration test.
4. Legal review of source licensing.
