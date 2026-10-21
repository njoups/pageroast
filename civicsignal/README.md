# CivicSignal Intelligence

Multi-tenant media monitoring and public-issue intelligence platform (Indonesia-first).
**Status:** Milestones 1 (foundation), 2 (news ingestion: RSS/Atom verified live, GDELT implemented but not verified live) and
3 (AI intelligence: analysis pipeline, stories, summaries, analytics) and 4 (issue detection and alerting: explainable rules, severity,
lifecycle, in-app/email/webhook notifications) and 5 (analytics and executive reporting: dashboard, five report templates, PDF/CSV,
scheduling) are done. A production-readiness hardening pass (2026-10-20) added session idle timeout and management, password
reset, a tamper-evident audit chain, enforced retention, legal hold, four-eyes deletion, readiness and metrics, CI security stages and
a verified backup/restore drill. It is **not** production-ready yet and holds no certification: see
[docs/PRODUCTION_READINESS_ASSESSMENT.md](docs/PRODUCTION_READINESS_ASSESSMENT.md) (blocking items: MFA via an IdP, staging with
PITR, an external penetration test, legal review). Social listening (2026-10-20): a YouTube Data API connector with quota,
budget and data-rights controls, contract-tested against a mock API but **not verified live** (no API key available); see
[docs/SOCIAL_CONNECTORS.md](docs/SOCIAL_CONNECTORS.md). Without `ANTHROPIC_API_KEY`, analysis uses a
rule-based baseline, labelled as such, whose tone estimates are weak; the AI-model adapter has not yet been verified against the
live API. Email has been verified against a local SMTP server only; WhatsApp is an unconfigured adapter.
Commercial layer (2026-10-20): versioned plans (seeded without prices), subscriptions, an idempotent usage ledger, quotas, contract and
manual invoicing, a billing page and a platform console. **No live payment provider** is integrated (default `BILLING_PROVIDER=none`), and
invoices are not tax invoices; see [docs/BILLING_AND_SUBSCRIPTIONS.md](docs/BILLING_AND_SUBSCRIPTIONS.md) and
[docs/COMMERCIAL_OPERATIONS_RUNBOOK.md](docs/COMMERCIAL_OPERATIONS_RUNBOOK.md).
Current, evidence-based status: [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md). Connectors: [docs/CONNECTORS.md](docs/CONNECTORS.md).

- Plan and milestone status: [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md)
- Analytics and reports: [docs/ANALYTICS_METHODOLOGY.md](docs/ANALYTICS_METHODOLOGY.md) · [docs/REPORT_TEMPLATES.md](docs/REPORT_TEMPLATES.md)
- Alerts: [docs/ALERT_RULES.md](docs/ALERT_RULES.md) · [docs/NOTIFICATIONS.md](docs/NOTIFICATIONS.md) · Operations: [docs/RUNBOOK.md](docs/RUNBOOK.md)
- AI: [docs/AI_PROVIDERS.md](docs/AI_PROVIDERS.md) (configuration) · [docs/AI_EVALUATION.md](docs/AI_EVALUATION.md) (measured quality and limits)
- Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · Security: [docs/SECURITY.md](docs/SECURITY.md) · Data governance: [docs/DATA_GOVERNANCE.md](docs/DATA_GOVERNANCE.md)
- Production: [readiness assessment](docs/PRODUCTION_READINESS_ASSESSMENT.md) · [deployment and rollback](docs/DEPLOYMENT.md) · [backup and recovery](docs/BACKUP_AND_RECOVERY.md) · [disaster recovery](docs/DISASTER_RECOVERY.md) · [incident response](docs/INCIDENT_RESPONSE.md) · [supply chain](docs/SUPPLY_CHAIN.md) · [load testing](docs/LOAD_TESTING.md)

## Layout
```
apps/api   NestJS REST API (/api/v1, OpenAPI at /api/docs)
apps/web   Next.js App Router UI (proxies /api/v1 to the API, same-origin)
db/migrations  Plain SQL migrations (immutable once applied, checksummed)
scripts    backup.sh / restore.sh / verify-restore.sh (restore drill), scan-secrets.mjs, check-licenses.mjs, load/ (load test)
```

## Run locally (without Docker)
Requires Node 20+, PostgreSQL 16 and Redis 7 (Redis is needed for collection and analysis).

```bash
npm ci
createdb civicsignal                         # as a Postgres owner/superuser role
export MIGRATION_DATABASE_URL=postgres://<owner>:<pw>@localhost:5432/civicsignal
APP_DB_PASSWORD=<choose-one> npm run migrate # creates schema, RLS, and gives civicsignal_app LOGIN

# Terminal 1 — API on :4000 (connects as the restricted, RLS-bound app role)
cd apps/api
DATABASE_URL=postgres://civicsignal_app:<choose-one>@localhost:5432/civicsignal \
MIGRATION_DATABASE_URL=$MIGRATION_DATABASE_URL npm run dev

# Terminal 2 — worker: ingestion, AI analysis, issue detection, notifications, analytics aggregation and reports (add SMTP_URL/EMAIL_FROM for email). Add ANTHROPIC_API_KEY=... to use an AI model.
cd apps/api
DATABASE_URL=postgres://civicsignal_app:<choose-one>@localhost:5432/civicsignal REDIS_URL=redis://localhost:6379/0 npm run worker

# Terminal 3 — web on :3000
cd apps/web && npm run dev
```
Also set `REDIS_URL` for the API in terminal 1, so "Collect now" and retries can be queued.
Open http://localhost:3000, register, and create an organization.
To make an operator a platform admin (tenant metadata only, no content access):
`MIGRATION_DATABASE_URL=... npx tsx apps/api/src/database/promote-platform-admin-cli.ts you@example.com`

## Run on a laptop with Docker (recommended)
One command creates `.env` with random local secrets, picks free ports, builds and starts every service, and waits for health checks:
```bash
bash scripts/local-up.sh                                          # macOS / Linux / WSL
powershell -ExecutionPolicy Bypass -File scripts\local-up.ps1     # Windows
```
- App: http://localhost:3000.
- Local email inbox (Mailpit; every email the app sends): http://localhost:8025.
- Step-by-step guide in Indonesian: [docs/LOCAL_SETUP.md](docs/LOCAL_SETUP.md). To let a Claude Code session on the laptop do it: [docs/LOCAL_SESSION_HANDOFF.md](docs/LOCAL_SESSION_HANDOFF.md).
- Verified on 2026-10-21 in the development container: all services healthy, smoke test 18/18, password-reset email delivered to Mailpit. In that sandbox the images were assembled offline; the real Dockerfiles are built in CI.
- Not yet tried on a physical Windows or macOS laptop.
- Compose is for local use only (`APP_ENV=local`); staging and production are described in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Tests
```bash
# Needs a Postgres where the given user can CREATE DATABASE and CREATE ROLE.
TEST_ADMIN_DATABASE_URL=postgres://postgres@localhost:5432/postgres TEST_REDIS_URL=redis://localhost:6379/15 npm test
npm run lint && npm run typecheck && npm run build
npm run eval:ai -w apps/api   # evaluation of the rule-based baseline (add -- --llm with a key for the AI model)
```
The suite drops and recreates the `civicsignal_test` database and flushes Redis database 15.

## Credentials / external services
| Service | Needed for | Status |
|---|---|---|
| PostgreSQL 16 | everything | required |
| Managed IdP (OIDC) | **MFA** (blocking for production) | **not configured**: local adapter in use; it has no MFA |
| Email (SMTP) | alert emails, password-reset emails (invitations still use manual links) | `SMTP_URL` + `EMAIL_FROM`; verified against a local SMTP server only. Without it, password reset returns 503. |
| `METRICS_TOKEN` | `/metrics` scraping | optional; `/metrics` is 404 without it |
| WhatsApp Business Cloud API | optional alert channel | **not configured**; shown as unconfigured |
| Redis | ingestion and analysis queues, worker gates | required for collection and analysis |
| `CREDENTIALS_KEY` | encrypting connector credentials and webhook signing secrets | required for webhooks |
| Source licences | every source you enable | **required**: only a recorded basis allows collection |
| Licensed news provider / publisher API | a second commercial connector | not contracted; not built |
| `ANTHROPIC_API_KEY` | AI-model analysis (docs/AI_PROVIDERS.md) | **not configured**: rule-based baseline in use, labelled in the UI |
| YouTube Data API key | social listening (YouTube connector) | **not configured**: connector built and contract-tested; set per connector in the Social listening workspace |
| Other social APIs (X, Meta, TikTok) / licensed social data | further social connectors | not contracted; capability matrix only |
