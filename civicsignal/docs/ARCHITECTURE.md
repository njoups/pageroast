# Architecture

## Shape
Modular monolith. One NestJS process exposes a versioned REST API (`/api/v1`). A Next.js app is the only
first-party client. Background workers (M2+) are separate processes of the same codebase using BullMQ.

```
Browser ──HTTPS──> Next.js (apps/web) ──cookie-forwarding──> NestJS API (apps/api) ──> PostgreSQL (RLS)
                                                          └──> Redis/BullMQ (M2+) ──> workers ──> connectors / LLM
```

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
See `db/migrations`. All 21 required tables exist from M1; only identity/tenancy/projects/audit tables are exercised by M1 code.
