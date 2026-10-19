# Security

> No certification or compliance is claimed. Controls listed as *planned* are not implemented.

## Implemented in M1
| Control | Status |
|---|---|
| Passwords hashed with scrypt (N=2^15, per-user salt, timing-safe compare) | ✅ |
| Opaque session tokens (256-bit), only SHA-256 stored, httpOnly + SameSite=Lax + Secure(prod) cookie | ✅ |
| Session expiry and revocation (logout, password change revokes all) | ✅ |
| RLS tenant isolation, forced, non-owner role | ✅ tested |
| Role-permission matrix enforced server-side | ✅ tested |
| Append-only audit log (UPDATE/DELETE revoked + trigger) | ✅ tested |
| Input validation (whitelist, forbid unknown props) | ✅ tested |
| Rate limiting on auth endpoints | ✅ tested |
| Security headers (helmet) | ✅ |
| CSRF: `SameSite=Lax` cookie; mutating requests with a foreign `Origin` (or `Sec-Fetch-Site: cross-site`) rejected; API parses JSON bodies only | ✅ tested |
| User enumeration resistance on login/register | 🟡 login uniform; register reveals duplicates by design (documented trade-off) |
| MFA | ⬜ planned via managed IdP |
| Dependency audit | `npm audit --omit=dev --audit-level=high` gates CI; 0 production advisories at time of writing |
| Secrets | env only; `.env.example` has placeholders; no secrets committed |

## Threat model (summary)
| Threat | Mitigation |
|---|---|
| Cross-tenant data access | RLS + guard + 404 on non-membership |
| Privilege escalation via role change | Only owner can grant admin/owner; last owner cannot be demoted/removed |
| Platform-admin overreach | No implicit tenant permissions; break-glass planned (M6) |
| Session theft | httpOnly, hashed storage, short TTL, revocation |
| Credential stuffing | rate limit, scrypt cost |
| Prompt injection from scraped content (M3) | content treated as data, no tools reachable from summariser, output schema validation |
| SSRF via connector URLs (M2) | allow-list of registered sources, block private IP ranges |
| Audit tampering | append-only, hash-chain planned (M6) |

## Data-flow (M1)
Browser → Next.js (same-origin proxy) → API → Postgres. Passwords never leave the API; tokens only as httpOnly cookies.

## Access-control matrix
Generated from `apps/api/src/authz/permissions.ts`; a test fails if this table drifts.

<!-- MATRIX:START -->
| Permission | owner | admin | project_manager | analyst | report_viewer |
|---|:-:|:-:|:-:|:-:|:-:|
| `org:read` | ✔ | ✔ | ✔ | ✔ | ✔ |
| `org:update` | ✔ | ✔ |  |  |  |
| `members:read` | ✔ | ✔ | ✔ | ✔ |  |
| `members:invite` | ✔ | ✔ |  |  |  |
| `members:update_role` | ✔ | ✔ |  |  |  |
| `members:remove` | ✔ | ✔ |  |  |  |
| `projects:read` | ✔ | ✔ | ✔ | ✔ | ✔ |
| `projects:create` | ✔ | ✔ | ✔ |  |  |
| `projects:update` | ✔ | ✔ | ✔ |  |  |
| `projects:archive` | ✔ | ✔ | ✔ |  |  |
| `projects:delete` | ✔ | ✔ |  |  |  |
| `projects:manage_members` | ✔ | ✔ | ✔ |  |  |
| `audit:read` | ✔ | ✔ |  |  |  |
| `sources:read` | ✔ | ✔ | ✔ | ✔ |  |
| `sources:manage` | ✔ | ✔ | ✔ |  |  |
| `mentions:read` | ✔ | ✔ | ✔ | ✔ |  |
| `alerts:read` | ✔ | ✔ | ✔ | ✔ |  |
| `alerts:acknowledge` | ✔ | ✔ | ✔ | ✔ |  |
| `alerts:manage` | ✔ | ✔ | ✔ |  |  |
| `reports:read` | ✔ | ✔ | ✔ | ✔ | ✔ |
| `reports:generate` | ✔ | ✔ | ✔ | ✔ |  |
| `billing:read` | ✔ | ✔ |  |  |  |
| `billing:manage` | ✔ |  |  |  |  |
| `retention:manage` | ✔ | ✔ |  |  |  |
| `data:export` | ✔ | ✔ |  |  |  |
| `data:delete` | ✔ |  |  |  |  |
| `analysis:reprocess` | ✔ | ✔ | ✔ |  |  |
| `ai:settings` | ✔ | ✔ |  |  |  |

Platform administrators hold **no** tenant permissions. Project-scoped reads for project_manager, analyst and report_viewer are further limited to projects they are assigned to.
<!-- MATRIX:END -->

## Incident response (initial)
1. Triage and declare severity. 2. Contain (revoke sessions via `sessions.revoked_at`, rotate secrets). 3. Preserve audit/log evidence.
4. Notify affected tenants per contract and applicable law (counsel decides timelines). 5. Post-incident review.

## Backup and recovery
Production: managed PostgreSQL PITR + daily snapshots, restore drill quarterly. Local: `scripts/backup.sh` (pg_dump) and `scripts/restore.sh`.
A backup → restore drill was run on 2026-10-19 against a local PostgreSQL 16 cluster (row counts matched; forced RLS and app-role
isolation verified after restore). No production backup exists yet.
