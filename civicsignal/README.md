# CivicSignal Intelligence

Multi-tenant media monitoring and public-issue intelligence platform (Indonesia-first). **Status: Milestone 1 (foundation) complete.**
News ingestion, AI analysis, alerts, analytics and reports are *not* built yet; their navigation entries are labelled as unavailable.

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
Requires Node 20+ and PostgreSQL 16.

```bash
npm ci
createdb civicsignal                         # as a Postgres owner/superuser role
export MIGRATION_DATABASE_URL=postgres://<owner>:<pw>@localhost:5432/civicsignal
APP_DB_PASSWORD=<choose-one> npm run migrate # creates schema, RLS, and gives civicsignal_app LOGIN

# Terminal 1 — API on :4000 (connects as the restricted, RLS-bound app role)
cd apps/api
DATABASE_URL=postgres://civicsignal_app:<choose-one>@localhost:5432/civicsignal \
MIGRATION_DATABASE_URL=$MIGRATION_DATABASE_URL npm run dev

# Terminal 2 — web on :3000
cd apps/web && npm run dev
```
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
TEST_ADMIN_DATABASE_URL=postgres://postgres@localhost:5432/postgres npm test
npm run lint && npm run typecheck && npm run build
```
The suite drops and recreates the `civicsignal_test` database.

## Credentials / external services
| Service | Needed for | Status |
|---|---|---|
| PostgreSQL 16 | everything | required |
| Managed IdP (Supabase Auth / OIDC) | MFA, password recovery, production auth | **not configured**: local adapter in use |
| Email provider | invitations, alerts | **not configured**: invitations use manual links |
| Redis | queues, distributed rate limiting | Milestone 2 |
| News sources / LLM provider / social APIs | Milestones 2–7 | none configured or verified |
