# Data Governance

> This document describes engineering controls. It is **not legal advice** and asserts no regulatory compliance.
> Indonesian personal-data protection (UU PDP No. 27/2022), government procurement rules, data-residency requirements,
> and customer contracts must be assessed by qualified counsel before production use with government customers.

## Principles
1. **Licence first.** Each source records authorization status, permitted fields, retention, and attribution. The pipeline
   (M2) stores only fields permitted by the source's licence; a full article body is stored only when `permits_full_text = true`.
2. **No circumvention.** No paywall, CAPTCHA, auth, quota, or platform-restriction bypass.
3. **Provenance.** Every mention keeps source, collection method, discovery time (separate from publication time), and licence reference.
4. **Minimisation.** Collect keyword-matched records for a project; no bulk profiling of individuals.
5. **No individual scoring.** The product must not compute citizen, loyalty, or other scores about individuals, nor feed automated decisions affecting individual rights.
6. **Tenant ownership.** Customer configuration and derived data belong to the tenant; export and deletion are supported (workflows in M6).

## Data classes
| Class | Examples | Handling |
|---|---|---|
| Account | email, name, password hash | scrypt hashes; never logged |
| Tenant config | projects, queries, alert rules | RLS-isolated; audit on change |
| Source content | headlines, excerpts, permitted bodies | licence-driven retention |
| Derived | sentiment, entities, summaries | stored with model/prompt versions and evidence |
| Audit | audit_events | append-only, retained ≥ 12 months (configurable per tenant, not below the floor) |

## Ingestion controls (implemented in Milestone 2)
- **Authorization gate:** a source cannot be enabled or collected until it is `authorized`, and that status requires a recorded
  basis (DB `CHECK` constraint). Revoking authorization disables collection immediately.
- **Field-level licence filter:** only `permitted_fields` are stored. Full text is stored only when `permits_full_text` is true **and**
  the feed itself carries it. Article pages are never fetched, so paywalls, logins and CAPTCHAs are never touched; a 401, 403 or 451
  response, or an HTML login page, is recorded as a permanent failure and never retried around.
- **Licence snapshot:** every mention stores the source's licence terms *as they were at collection time* in `provenance.licence`,
  plus connector, run id and original URL. Discovery time is stored separately from the publisher's publication time and is never
  overwritten. GDELT records carry no publication time (GDELT does not provide one).
- **Retention:** `retention_expires_at` is computed from the source's `retention_days`. **Automatic deletion is not yet implemented**
  (Milestone 6), so expired records stay until then. This is a known gap.
- **Provenance protection:** sources with collected records cannot be deleted.
- **Politeness:** an identifying User-Agent, per-host spacing, per-source rate limits and daily quotas, and `Retry-After` and
  `Cache-Control` honoured (max-age capped at 1 h, see CONNECTORS.md).

## Retention
`retention_policies` stores per-tenant, per-data-class retention. Defaults are conservative; enforcement jobs arrive in M6.
Retention may be shortened by a source licence but never lengthened beyond it.

## Source licence registry
The `sources` table (with `connectors`) is the registry. No source is seeded. Operators enter the authorization basis.
The two RSS sources used for live verification in the development database were marked authorized *for a limited integration test only*.
Their basis text says so, and their publishers' terms have **not** been reviewed (see CONNECTORS.md).

## Open items for legal review
UU PDP applicability to public-figure mentions · hosting location · cross-border transfer of LLM prompts · publisher terms for RSS reuse and excerpts.
