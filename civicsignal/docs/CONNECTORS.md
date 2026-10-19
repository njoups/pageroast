# Connectors: configuration, operation and testing

## Available connectors

| Kind | Collection method | Credentials | Status (2026-10-19) |
|---|---|---|---|
| `feed`: RSS 2.0, RSS 1.0 (RDF), Atom | `rss` / `atom` | none | **Verified live**: ANTARA News Terkini and CNN Indonesia Nasional, see below |
| `gdelt`: GDELT DOC 2.0 article list | `licensed_provider` (open-data licence) | none | **Implemented and contract-tested; NOT verified live.** Every live attempt from this environment got HTTP 429/503 from GDELT |

There is no connector for a commercial licensed provider or publisher API yet. The credential storage it would need is built
(AES-256-GCM, `PUT /sources/:id/credentials`), but no connector uses it today; the API refuses credentials for `feed` and `gdelt`.

## Registering a source (UI: Sources → Add source; API: `POST /api/v1/organizations/:orgId/sources`)

```json
{
  "kind": "feed",
  "name": "Publisher X: National",
  "feedUrl": "https://publisher.example/rss/national.xml",
  "format": "rss",
  "authorizationStatus": "authorized",
  "authorizationBasis": "Written permission from Publisher X, ref. PX-2026-014, valid until 2027-06-30",
  "permittedFields": ["title", "url", "published_at", "excerpt"],
  "permitsFullText": false,
  "refreshIntervalSeconds": 3600,
  "rateLimitPerMinute": 2,
  "quotaPerDay": 48,
  "retentionDays": 365,
  "licenseTerms": "Headlines and summaries for internal monitoring",
  "redistributionRestrictions": "No redistribution outside the customer organisation",
  "attributionRequirement": "Publisher X"
}
```

GDELT: `{"kind": "gdelt", "connectorConfig": {"query": "(banjir OR longsor) sourcecountry:indonesia", "timespan": "1h", "maxRecords": 75}, ...}`.

Rules enforced by the API **and** database constraints:
- `authorized` requires a non-empty `authorizationBasis`. Only authorized sources can be enabled or collected.
- Sources are created **disabled**. Enabling is a separate, audited action. Moving away from `authorized` disables collection.
- `permittedFields` must include `title` and `url`. Excerpts, authors, categories and publication times are stored only if listed.
  Full article text is stored only if `permitsFullText` is true and the feed includes it. Article pages are **never** fetched.
- Feed URLs: http/https only, ports 80/443, no credentials in the URL, no internal or cloud-metadata destinations.
- A source with collected records cannot be deleted (provenance); disable it instead.

## Running the ingestion worker

```bash
# Prerequisites: PostgreSQL (migrated) and Redis
export DATABASE_URL=postgres://civicsignal_app:<pw>@localhost:5432/civicsignal
export REDIS_URL=redis://localhost:6379/0
export INGESTION_USER_AGENT="CivicSignalBot/0.2 (+mailto:ops@your-org.example)"

npm run worker -w apps/api                 # development (tsx): consumer + scheduler + heartbeat
npm run build -w apps/api && npm run worker:prod -w apps/api   # production build
node apps/api/dist/worker.js --no-scheduler   # consumer only (scale horizontally)
node apps/api/dist/worker.js --no-consumer    # scheduler only
```

The API also needs `REDIS_URL` to queue "Collect now" and retry requests; without it those endpoints answer `503 queue_unavailable`.
Docker Compose runs `redis` and `worker` services.

| Variable | Default | Meaning |
|---|---|---|
| `INGESTION_WORKER_CONCURRENCY` | 4 | Jobs processed in parallel per worker (each source is still collected one at a time) |
| `INGESTION_ATTEMPTS` | 5 | Attempts per job before dead-lettering |
| `INGESTION_BACKOFF_BASE_MS` | 30000 | Exponential backoff base (±30% jitter, max 30 min); provider `Retry-After` wins |
| `INGESTION_SCHEDULER_INTERVAL_MS` | 15000 | How often due sources are enqueued |
| `INGESTION_HTTP_TIMEOUT_MS` | 30000 | Whole-request timeout |
| `INGESTION_MAX_RESPONSE_BYTES` | 5 MiB | Response cap (after decompression) |
| `INGESTION_MAX_CACHE_SECONDS` | 3600 | Cap on honoured `Cache-Control: max-age` |
| `INGESTION_DEFAULT_HOST_SPACING_MS` | 1000 | Minimum gap between requests to one host, across all tenants |
| `INGESTION_HOST_SPACING` | `api.gdeltproject.org=6000` | Per-host overrides, `host=ms,host=ms` |
| `DEDUP_TITLE_SIMILARITY` | 0.9 | Same-publisher headline similarity for near-duplicates (0 disables) |
| `CREDENTIALS_KEY` | (unset) | base64 32-byte key for credential encryption |
| `INGESTION_ALLOW_PRIVATE_HOSTS` | false | **Tests only**; refused when `NODE_ENV=production` |

## How a collection runs
1. The **scheduler** claims due rows in `ingestion_schedule` (`FOR UPDATE SKIP LOCKED`) and enqueues a job whose id is
   `sched_<source>_<due-epoch>`, so concurrent schedulers can't create duplicates. Manual runs use `manual_<source>_<uuid>`; retries use `retry_<run>`.
2. The **worker** passes three gates, none of which consumes a retry attempt: a per-source Redis lock (one collection per source at a time),
   per-host spacing, and the source's per-minute rate limit and daily quota. A deferred job is delayed, not failed.
3. **Pipeline:** fetch (conditional GET with ETag/Last-Modified; `Cache-Control` honoured up to the cap) → validate → normalise →
   deduplicate → match queries → persist → queue analysis (*not implemented, Milestone 3*) → search index (generated column) →
   alerts (*not implemented, Milestone 4*) → metrics. The stage outcomes are stored on each run (`connector_runs.stages`).
4. **Errors:** `network`, `timeout`, `server` and `rate_limited` are retried. `auth`, `forbidden`, `not_found`, `malformed`, `unsafe` and
   `unconfigured` fail immediately: we never retry around access control. The final failure goes to the `ingestion-dlq` queue and the
   run is marked `dead_lettered` (or `failed` for non-retryable errors). Admins can retry a failed run once from the UI.
5. **Health** is derived from results only: `unknown` (never attempted), `healthy`, `degraded` (transient failure, or no success for
   3 refresh intervals), `failing` (3 consecutive failures or a non-transient error), `disabled`.

## Deduplication
- One record per tenant per **canonical URL** (lowercased host, no fragment, no `utm_*`/`fbclid`/…, sorted query, no trailing slash).
  A re-seen URL is counted as "known"; if another source sees it, that source is added to `provenance.alsoSeenIn`.
- **Same publisher** + identical content hash, or identical normalised headline → stored, flagged `duplicate`, linked via `duplicate_of`.
- **Same publisher** + headline similarity ≥ 0.9 (headlines of ≥5 words) → `near_duplicate`.
- Different publishers are **never** merged, even with identical wire copy. Duplicates are hidden by default and not matched to queries.

## Monitoring queries
Keywords, aliases (any must match), exclusions (none may match) and an optional Boolean expression:
`AND`, `OR`, `NOT` / `-word`, `"exact phrase"`, `( … )`, `prefix*` (≥3 letters). Operators are uppercase; matching ignores case and accents and
works on whole words. Expressions are parsed into an AST and evaluated in memory; they are never turned into SQL or code. Limits:
2,000 characters, 100 terms, 12 levels of nesting. Saving a query re-matches the most recent 5,000 originals.

## Testing
```bash
TEST_ADMIN_DATABASE_URL=postgres://postgres@localhost:5432/postgres TEST_REDIS_URL=redis://localhost:6379/15 npm test
```
- Unit: feed parsing (RSS 2.0/1.0, Atom, malformed, entity expansion, HTML login pages, Indonesian dates), URL canonicalisation,
  SSRF address policy, query language, dedup, health transitions, backoff, credential encryption, connector contract for both connectors.
- Integration (local synthetic feed server; **no live network**): SSRF via DNS and redirects, size/timeout/redirect limits, the whole pipeline
  against PostgreSQL, tenant isolation, licence-based field storage, BullMQ with real Redis (idempotent job ids, scheduler de-duplication,
  retries → dead letter, per-source lock, rate limits, retry API).
- Fixtures in `apps/api/test/fixtures` are synthetic and labelled; GDELT tests use a hand-written JSON fixture, not a recorded response.

## Live verification record (2026-10-19, this development environment)
| Source | Result |
|---|---|
| ANTARA News Terkini RSS (`https://www.antaranews.com/rss/terkini.xml`) | Run 1: HTTP 200, 50 items, 50 stored, 0 rejected, 6 query matches, 1.1 s. Run 2: HTTP 200, 3 new, 47 known (dedup by canonical URL). |
| CNN Indonesia Nasional RSS (`https://www.cnnindonesia.com/nasional/rss`) | Run 1: HTTP 200, 100 items, 100 stored, 39 matches, 0.3 s. Run 2: HTTP 200, 0 new, 100 known. |
| GDELT DOC 2.0 | 5 attempts at 15:59, 16:00, 16:01, 16:04 and ~16:08 UTC (gaps grow with backoff): all HTTP 503, then dead-lettered (1 DLQ job) and the source marked failing. Manual curl got 429 "limit requests to one every 5 seconds" even for single, spaced requests; most likely a shared egress IP. **Not verified.** |

Observations that changed the code:
- ANTARA serves its live feed with `Cache-Control: max-age=5184000` (60 days), so the honoured max-age is now capped (default 1 h).
- ANTARA regenerates the feed every minute and CNN sends no ETag, so a live `304 Not Modified` was not observed. Conditional requests are
  verified only against the local test server.

These two RSS sources were registered as `authorized` **for a limited integration test only**. Their recorded basis says publisher terms
have not been reviewed, and only headline, link and publication time were stored. Scheduled collection was left disabled.
Do not enable them for customers until the terms are reviewed.
