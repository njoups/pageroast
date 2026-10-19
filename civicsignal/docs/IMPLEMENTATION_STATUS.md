# Implementation Status

Last verified: 2026-10-19, from code and test runs (not from plans). Commands and results are at the bottom.

## Completed and verified
| Area | Evidence |
|---|---|
| Migrations 0001–0005 apply cleanly to an empty DB; re-run is a no-op; edited migrations are refused | `test/db/migrations.spec.ts` |
| RLS enabled **and forced** on all 24 tables; app role not superuser, no BYPASSRLS, owns nothing, no TEMP | migrations spec, mutation check (disabling RLS fails 7 tests) |
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

## Partially implemented
- **Identity:** local adapter only. No MFA, no password reset, no email verification.
- **Rate limiting:** in-process memory (per API instance).
- **Client IP:** trustworthy only behind an edge proxy that overwrites `X-Forwarded-For` (Caddy in `docker-compose.yml`).
  Next.js rewrites pass client-supplied `X-Forwarded-For` through unchanged (verified with an echo server).
- **Docker Compose:** config validates; images and stack have **not** been run (no Docker daemon available).

## Missing
- News ingestion: source registry API/UI, connectors, queue/worker, dedup, query matching, mentions UI (Milestone 2, in progress).
- AI analysis, alerts, analytics, reports, billing/metering, retention enforcement, export/deletion workflows, break-glass access.

## Broken
None known. All defects found in the audit below are fixed and have regression tests.

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

## Security risks (open)
1. **RLS context is set by the application.** An attacker with arbitrary SQL execution as the app role can set
   `app.tenant_id`/`app.system` and read any tenant. RLS guards against logic bugs, not SQL injection.
   Mitigations: parameterised queries only (no SQL string building with input), column grants, and no TEMP.
   Recommended later: per-request signed context or a separate role for system flows.
2. Local identity adapter in use (no MFA). Required before government production use.
3. Per-account lockout can be triggered by an attacker against a known email (bounded to 15 minutes).

## Data-source and licensing risks
- No source has been legally reviewed. Fetching a publicly offered RSS feed does not grant redistribution rights.
- See DATA_GOVERNANCE.md and docs/CONNECTORS.md (added with Milestone 2).

## Required external credentials
Managed IdP · email provider · licensed news provider (optional, Milestone 2 second connector) · Redis (local is fine for dev).

## Test results (2026-10-19)
`npm run lint` ✔ · `npm run typecheck` ✔ · API jest: 73 passed / 0 failed / 0 skipped · web node:test: 2 passed ·
`npm run build` ✔ · `npm audit --omit=dev`: 0 vulnerabilities · GitHub Actions run #1 on 7be9a24: success.

## Next milestone
Milestone 2, news ingestion: see docs/MILESTONE_2_PLAN.md (being implemented now).
