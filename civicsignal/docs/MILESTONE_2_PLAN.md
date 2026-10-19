# Milestone 2 — News Monitoring: Implementation Plan

Status: **prepared, not started.** Prepared 2026-10-19 after the foundation audit (docs/IMPLEMENTATION_STATUS.md).
No ingestion code exists today. Only the empty tables from migration 0002 (`sources`, `connectors`, `connector_runs`,
`mentions`, `monitoring_queries`) are present, and none are used by application code.

## Decisions needed before coding (owner: product/legal)

| # | Decision | Recommendation | Why it matters |
|---|---|---|---|
| D1 | Which first two sources, and on what legal basis? | Candidates below; each needs written approval before it is marked `authorized` | No source may be collected without a recorded authorization basis |
| D2 | Who holds the licence: the platform or each customer? | Support both: a platform **source catalogue** (operator-curated, with licence evidence) that tenants enable, plus tenant-registered sources | Decides whether `sources` stays purely tenant-owned |
| D3 | Store articles once per tenant, or once per project? | Once per tenant (`articles`), with per-project `mention_matches` | Today `mentions` is per project, which duplicates storage and dedup work when projects overlap |
| D4 | Hosting region for collected content | Indonesia or customer-specified region | Data-residency and procurement requirements (counsel) |

### Candidate connectors (none approved, none verified)
1. **RSS/Atom (generic):** for publishers whose feed terms permit monitoring use. Each feed URL becomes a source row with the
   publisher's terms recorded. Feeds normally permit headline + link + short summary only, so `permits_full_text = false`.
2. **Second connector, one of:**
   - *GDELT DOC 2.0 API*: open data with attribution; returns URL, title, publication time, language and source country. It needs no
     key, but its terms must still be reviewed and recorded.
   - *A licensed news-data provider* (commercial API). Needs a contract, an API key and its licence terms (full text or excerpt, retention).
   - *A publisher API* under a direct agreement with an Indonesian publisher.

Until D1 is answered, connectors are built and tested against **recorded fixtures labelled as fixtures**, and no source is
seeded or marked authorized.

## Scope and design

### 1. Source registry (API + UI)
- CRUD on `sources` with every field from migration 0002: licence, authorization status and basis, permitted fields,
  `permits_full_text`, refresh interval, rate limit, retention, attribution requirement.
- Only `authorization_status = 'authorized'` sources can be scheduled. Changing authorization is audited, and moving to
  `revoked` stops jobs immediately.
- New permissions are already in the matrix: `sources:read`, `sources:manage` (owner, admin, project manager).
- Migration 0005 (if D2/D3 are accepted): `source_catalog` (platform-owned, read-only to tenants), `sources.catalog_source_id`, and
  `articles` + `mention_matches` replacing per-project `mentions` (empty today, so no data migration is needed).

### 2. Connector contract (`apps/api/src/ingestion/connector.ts`)
```ts
interface Connector<Config> {
  kind: 'rss' | 'atom' | 'gdelt' | 'provider_x';
  validateConfig(raw: unknown): Config;                    // throws ConnectorConfigError
  fetchPage(ctx: FetchContext<Config>): Promise<{ records: RawRecord[]; nextCursor: string | null }>;
}
interface FetchContext<C> { config: C; cursor: string | null; http: SafeHttpClient; signal: AbortSignal; permittedFields: string[] }
type ConnectorError = 'auth' | 'quota' | 'rate_limited' | 'not_found' | 'malformed' | 'network' | 'forbidden_by_terms';
```
- A **shared contract test suite** runs against every connector: config validation, pagination termination, field
  filtering to `permittedFields`, error mapping, honouring `signal`, and no network calls outside `SafeHttpClient`.

### 3. Safe HTTP client
HTTPS only (HTTP only for explicitly allow-listed feeds). DNS is resolved and private/loopback/link-local/metadata ranges are blocked,
re-checked on every redirect (max 3). Timeouts are 10 s connect and 30 s total; responses are capped at 5 MB. The client sends an
identifying User-Agent and honours `Retry-After`. Robots/terms are policy recorded per source, not inferred.

### 4. Pipeline (BullMQ on Redis; new `apps/api/src/worker.ts` process)
1. The scheduler enqueues `collect:{sourceId}` every `refresh_interval_seconds`, with job id = `sourceId:windowStart`, so duplicates are no-ops.
2. A `connector_runs` row is created with a unique `(tenant, connector, idempotency_key)`; a re-run with the same key is skipped.
3. Fetch → normalise → validate → dedup → match → persist, all inside `withTenant`.
4. Retries: 5 attempts, exponential backoff with jitter. `quota`/`forbidden_by_terms` errors are not retried; after the final
   failure the job goes to a `collect-dlq` queue and the run is marked `dead_lettered`.
5. Per-source token bucket in Redis honours `rate_limit_per_minute`.
6. Health is computed from the last N runs: healthy / degraded / failing. `sources.last_success_at` and `health_status` are updated.

### 5. Normalisation and deduplication
- Canonical URL: lowercase scheme and host, strip `utm_*`, `fbclid`, `gclid` and the fragment, sort the query, drop the trailing slash; honour
  `<link rel=canonical>` only when the source provides it in the feed.
- `content_hash` = sha256 of normalised title + excerpt. Dedup on `(tenant, canonical_url)`, then a hash match within 72 h marks it a duplicate.
- Timestamps: `published_at` (publisher-reported, may be null), and `discovered_at` (our collection time) is always set and never overwritten.
- Language: from the feed if declared, else detection; `unknown` is allowed.
- Provenance JSON: connector kind and version, run id, raw identifiers, licence reference, attribution text.

### 6. Monitoring queries
Keywords, aliases, exclusions and a small Boolean grammar (`AND`, `OR`, `NOT`, quotes, parentheses). The parser has unit tests and
a max complexity limit. Matching is in-process at ingestion; search uses PostgreSQL FTS (`search_tsv`, already indexed).

### 7. Mentions search API + UI
Filters: project, source, date range (published vs discovered), language. Every result shows the original link, the
publisher, both timestamps, licence/attribution, and duplicate/related indicators. Unavailable sources are labelled.

### 8. Usage and licensing metadata
Per-run counts go to `usage_records` (`records_collected`, `requests_made` by source), feeding metering in M6.

## Acceptance criteria
1. Source registry CRUD with audit; unauthorized sources cannot be scheduled (tested).
2. The contract suite passes for every connector.
3. Each connector is **verified live** against an approved source. Evidence: `npm run connector:verify <sourceId>` records a
   successful `connector_runs` row and sets `connectors.verified_at`; output is pasted into the milestone report.
4. Queue tests: retry with backoff, idempotent re-delivery, dead-lettering, and rate-limit respect (Redis in CI).
5. Dedup tests: canonical-URL rules and hash duplicates; body stored only when `permits_full_text`.
6. SSRF tests: private IPs, DNS rebinding via redirect, and oversized responses are all rejected.
7. Cross-tenant tests for every new endpoint and worker path (a worker job for tenant A cannot write tenant B rows).
8. Health dashboard shows real run results, never placeholders.

## Credentials and approvals required
- Written approval of the first sources and their terms (D1), plus the D2/D3 decisions.
- Redis instance (local Compose service is enough for dev/CI).
- For a licensed provider: API key, plan quota, and the licence text (full text vs excerpt, retention period).
