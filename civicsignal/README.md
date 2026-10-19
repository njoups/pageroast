# CivicSignal Intelligence

Multi-tenant media monitoring and public-issue intelligence platform (Indonesia-first).
**Status:** Milestone 1 (foundation) and Milestone 2 (news ingestion: RSS/Atom verified live, GDELT implemented but not verified live) are done.
AI analysis, alerts, analytics and reports are *not* built yet; their navigation entries are labelled as unavailable.
Current, evidence-based status: [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md). Connectors: [docs/CONNECTORS.md](docs/CONNECTORS.md).

- Plan and milestone status: [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md)
- Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · Security: [docs/SECURITY.md](docs/SECURITY.md) · Data governance: [docs/DATA_GOVERNANCE.md](docs/DATA_GOVERNANCE.md)

## Layout
```
apps/api   NestJS REST API (/api/v1, OpenAPI at /api/docs)
apps/web   Next.js App Router UI (proxies /api/v1 to the API, same-origin)
db/migrations  Plain SQL migrations (immutable once applied, checksummed)
scripts    backup.sh / restore.sh
```

## Run locally (without Docker)
Requires Node 20+, PostgreSQL 16 and Redis 7 (Redis is needed for collection only).

```bash
npm ci
createdb civicsignal                         # as a Postgres owner/superuser role
export MIGRATION_DATABASE_URL=postgres://<owner>:<pw>@localhost:5432/civicsignal
APP_DB_PASSWORD=<choose-one> npm run migrate # creates schema, RLS, and gives civicsignal_app LOGIN

# Terminal 1 — API on :4000 (connects as the restricted, RLS-bound app role)
cd apps/api
DATABASE_URL=postgres://civicsignal_app:<choose-one>@localhost:5432/civicsignal \
MIGRATION_DATABASE_URL=$MIGRATION_DATABASE_URL npm run dev

# Terminal 2 — ingestion worker (consumer + scheduler)
cd apps/api
DATABASE_URL=postgres://civicsignal_app:<choose-one>@localhost:5432/civicsignal REDIS_URL=redis://localhost:6379/0 npm run worker

# Terminal 3 — web on :3000
cd apps/web && npm run dev
```
Also set `REDIS_URL` for the API in terminal 1, so "Collect now" and retries can be queued.
Open http://localhost:3000, register, and create an organization.
To make an operator a platform admin (tenant metadata only, no content access):
`MIGRATION_DATABASE_URL=... npx tsx apps/api/src/database/promote-platform-admin-cli.ts you@example.com`

## Run with Docker Compose
```bash
cp .env.example .env    # set real passwords
docker compose up --build
```
The Compose file passes `docker compose config` validation. It has not been run end-to-end yet because no Docker daemon was available while it was written.

## Tests
```bash
# Needs a Postgres where the given user can CREATE DATABASE and CREATE ROLE.
TEST_ADMIN_DATABASE_URL=postgres://postgres@localhost:5432/postgres TEST_REDIS_URL=redis://localhost:6379/15 npm test
npm run lint && npm run typecheck && npm run build
```
The suite drops and recreates the `civicsignal_test` database and flushes Redis database 15.

## Credentials / external services
| Service | Needed for | Status |
|---|---|---|
| PostgreSQL 16 | everything | required |
| Managed IdP (Supabase Auth / OIDC) | MFA, password recovery, production auth | **not configured**: local adapter in use |
| Email provider | invitations, alerts | **not configured**: invitations use manual links |
| Redis | ingestion queue, worker gates | required for collection |
| `CREDENTIALS_KEY` | encrypting connector credentials | optional until a credentialed connector exists |
| Source licences | every source you enable | **required**: only a recorded basis allows collection |
| Licensed news provider / publisher API | a second commercial connector | not contracted; not built |
| LLM provider / social APIs | Milestones 3–7 | none configured |
