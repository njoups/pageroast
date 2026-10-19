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
```

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

## API modules (apps/api/src)
| Module | Responsibility |
|---|---|
| `database` | Pool, migrations runner, `withTenant()` / `withSystem()` transaction helpers |
| `identity` | `IdentityProvider` port; `LocalIdentityProvider` (scrypt + opaque DB sessions) |
| `auth` | Register/login/logout/me, session guard, rate limiting |
| `organizations` | Org creation, settings, memberships, invitations |
| `projects` | Projects, project members, archive/delete |
| `audit` | Append-only audit writer and viewer |
| `authz` | Role → permission matrix, `@RequirePermission()` guard |
| `health` | Liveness/readiness |

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
SHA-256 hashes of opaque 256-bit session tokens. It exists so the product runs without external credentials. A managed
provider (Supabase Auth / OIDC with MFA) must be added behind the same port before production. MFA is **not** implemented.

## Authorization
Roles: `platform_admin` (user flag, not a membership), `owner`, `admin`, `project_manager`, `analyst`, `report_viewer`.
The matrix lives in `apps/api/src/authz/permissions.ts` and is the single source of truth; docs/SECURITY.md mirrors it.
Platform admins hold no tenant permissions. Operational access to customer content will use time-boxed, reasoned,
audited break-glass grants (M6).

## Error envelope
`{ "error": { "code": "validation_failed", "message": "...", "details": [...], "requestId": "..." } }`

## Data model
See `db/migrations` (0001–0006). Tables for analysis, alerts, reports and billing exist but are not yet used by application code.
