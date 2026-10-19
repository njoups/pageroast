# CivicSignal Intelligence — Implementation Plan

Status legend: ✅ done and tested · 🟡 partial · ⬜ not started. Statuses are updated only
when implementation **and** tests support them. See the bottom of each milestone for known limitations.

## Repository decision

The workspace contained two unrelated repositories: `caribisnis-id` (a live Next.js business
directory) and `pageroast` (an SEO report). Neither shares a domain with this product, so
CivicSignal lives in its own npm-workspaces root at `pageroast/civicsignal/`. No existing code was
modified. It can be extracted to its own repository with `git subtree split`.

## Stack (as built)

| Layer | Choice | Notes |
|---|---|---|
| API | NestJS 11 (modular monolith), TypeScript strict | OpenAPI at `/api/docs` |
| DB | PostgreSQL 16, plain-SQL migrations, `pg` | No ORM: RLS context is explicit |
| Tenant isolation | Row-level security, `FORCE`d, non-owner app role | Verified against a real Postgres |
| Identity | `IdentityProvider` port + `LocalIdentityProvider` | **Dev/pilot adapter.** Supabase/OIDC adapter not built (see M1 limitations) |
| Web | Next.js App Router, Tailwind, strict TS | |
| Queue | Redis + BullMQ | introduced in M2 |
| AI worker | TypeScript, same worker process as ingestion (BullMQ `analysis` queue) | M3; Python was planned but not needed: the provider SDK and all rules run in Node |

## Milestone 1 — Foundation ✅ (verified 2026-10-19)

Scope: auth, tenancy, roles, projects, migrations, UI shell, CI, audit log.

Acceptance criteria
1. Migrations apply cleanly to an empty database and are idempotent via a version ledger; full schema (all 21 required tables) exists.
2. Every tenant-owned table has RLS enabled and forced; the app role is not a superuser, not the table owner, and lacks BYPASSRLS.
3. A query run as tenant A can never read or write tenant B rows (tested at DB level *and* HTTP level).
4. Register → login → create org → create project → invite member → change role → archive/delete project works end-to-end through the API.
5. Role matrix enforced server-side; platform admin has **no** implicit access to tenant content (tested).
6. Sensitive operations write append-only audit events; the app role cannot UPDATE/DELETE them (tested).
7. Input validation, consistent error envelope, rate limiting on auth endpoints (tested).
8. UI shell with all 11 navigation sections; unbuilt sections are explicitly labelled unavailable; overview shows only real data.
9. Lint, type check, and tests pass in CI.

Results: criteria 1–8 verified by 58 automated tests (unit, migration, DB-level RLS, HTTP e2e) against PostgreSQL 16, plus a
browser smoke run of the full UI flow. Criterion 9: the workflow (`.github/workflows/civicsignal-ci.yml`) runs the same
commands that pass locally; its first GitHub Actions run had not been observed at the time of writing.

M1 limitations (carried forward)
- **Identity:** `LocalIdentityProvider` only. No MFA, no password recovery, no email verification. A managed IdP adapter
  (Supabase Auth or OIDC) is required before production use with government customers.
- **Email:** no provider configured. Invitations return a one-time link that an admin shares manually.
- **Rate limiting** is in-process memory; it must move to Redis when there is more than one API instance.
- **Break-glass support access** for platform admins is designed but not built (M6). Today platform admins see tenant metadata only.
- Members cannot leave an organization themselves; an owner/admin must remove them.
- Docker images and Compose are config-validated, but the containers have not been built and run here: no Docker daemon was available.

## Milestone 2 — News monitoring ✅ RSS/Atom verified live · 🟡 GDELT not verified live (2026-10-19)
Acceptance criteria
1. Source registry CRUD with licence, authorization basis, permitted fields, retention and attribution; only `authorized` sources can be scheduled.
2. `Connector` interface + shared contract test suite every connector must pass (fetch, normalise, error taxonomy, rate-limit respect).
3. RSS/Atom connector and one publisher/licensed-API connector, each verified against a live source the customer is authorized to use, with the verification recorded.
4. BullMQ pipeline: idempotency keys, exponential backoff, dead-letter queue, connector_runs ledger (queue retry tests).
5. Dedup by canonical URL + content hash; body stored only when `permits_full_text`.
6. Monitoring queries (keywords, aliases, exclusions, Boolean) with a tested parser; mention search via Postgres FTS with filters.
7. Connector health dashboard; SSRF protection (private-range block) on fetchers.
8. Cross-tenant tests for every new endpoint.
Source registry, connector interface + contract tests, two approved connectors (RSS/Atom + one
publisher/licensed API), BullMQ pipeline with idempotency/backoff/DLQ, dedup (canonical URL + content hash),
FTS mention search, connector health dashboard.
Acceptance: real records collected from ≥2 approved sources; duplicates collapsed; provenance and license stored;
body stored only if the source licence permits; cross-tenant search tests.

Results: see docs/IMPLEMENTATION_STATUS.md and docs/CONNECTORS.md. Criterion 3 is met for the RSS/Atom connector (two live Indonesian
feeds). The GDELT connector passes its contract tests, but every live attempt from the development environment was throttled or answered 503,
so it is **not** counted as verified.

## Milestone 3 — AI intelligence ✅ pipeline, baseline, UI verified · 🟡 AI model not verified live (2026-10-19)
Provider-independent adapter (Anthropic, rule-based baseline, test fixture), structured-output validation, sentiment/topic/entity/
summary/story clustering with evidence references, prompt-injection containment, token and cost accounting, model, prompt and
taxonomy version tracking, reprocessing, analytics UI. No API key was available, so the Anthropic adapter is tested against mocked HTTP
only. Measured quality: docs/AI_EVALUATION.md (baseline tone is weak on held-out data).

## Milestone 4 — Issue detection and alerts ✅ verified on live data · 🟡 email via local SMTP only, WhatsApp unconfigured (2026-10-19)
Aggregates with documented formulas, share-of-voice disclosure, alert rules, spike detection, notifications, ack/escalation, incident timeline.

## Milestone 5 — Reporting ⬜ (next)
PDF/CSV, scheduled generation, templates, citations, report history, mandatory report metadata.

## Milestone 6 — Commercial readiness ⬜
Metering, plan limits (server-enforced), billing port, retention jobs, export/delete workflows, break-glass support access, monitoring, hardening.

## Milestone 7 — Expansion ⬜
Social connectors (only after credentials + quota verification), media relations, visual analytics, international sources.

## Cross-cutting rules
- Never mark a connector "operational" without a recorded successful live verification.
- No fabricated data in production paths. Demo fixtures only behind an explicit `DEMO_MODE` flag and always labelled.
- No citizen/individual scoring or automated determinations affecting individual rights.
