# AI providers: configuration and behaviour

CivicSignal analyses each collected record (language, entities, topics, sentiment, summary) and groups related records into
stories. Every analysis records the **method** that produced it. The UI shows that method next to each result:

| Method | Provider | When it is used | Shown as |
|---|---|---|---|
| `llm` | `anthropic` | `ANTHROPIC_API_KEY` is set (or `AI_PROVIDER=anthropic`) | "AI model · <model id>" |
| `baseline` | `baseline` | No key configured, or as the outage/refusal fallback | "Rule-based baseline" |
| `test` | `test` | Automated tests only; **refused when `NODE_ENV=production`** | "Test fixture (not real analysis)" |

**Live status (2026-10-19):** no API key was available while this was built. The Anthropic adapter has been tested only
against a **mocked HTTP layer** (`test/unit/analysis/anthropic-adapter.spec.ts`). It has **not** been verified against the live
API. All analysis stored in the development database was produced by the rule-based baseline.

## Environment variables (API and worker)

| Variable | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | (none) | Server-side only. Never sent to the browser, logged, or stored in the database. |
| `AI_PROVIDER` | `anthropic` if a key is set, else `baseline` | `anthropic` \| `baseline` \| `test` (test refused in production) |
| `AI_MODEL` | `claude-opus-5-5` (in `config.ts`) | Model id. The only place a model name is configured; change it here, not in code. |
| `AI_EFFORT` | `low` | `low` … `max`. Higher effort spends more tokens per record. |
| `AI_ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | Explicit endpoint. Ambient `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` are deliberately ignored. |
| `AI_TIMEOUT_MS` | `60000` | Per-request timeout. A timeout is a retryable error. |
| `AI_REFUSAL_FALLBACK` | on | Sends `fallbacks: "default"` with the `server-side-fallback-2026-07-01` beta header, so a refusal can be retried server-side on a fallback model. Set `off` to disable. |
| `AI_FALLBACK` | `baseline` | After the final attempt fails, or on a non-retryable error: `baseline` stores the rule-based result marked `partial`; `none` marks the analysis `failed`. |
| `AI_CONCURRENCY` | `2` | Analysis jobs per worker process. |
| `AI_REQUESTS_PER_MINUTE` | `30` | Provider request budget across all workers (Redis counter). Excess jobs are deferred without spending an attempt. |
| `AI_ATTEMPTS` | `4` | Attempts per analysis job. |
| `AI_BACKOFF_BASE_MS` | `20000` | Exponential backoff base, ±30 % jitter, capped at 30 min. A provider `retry-after` takes precedence. |
| `CLUSTER_THRESHOLD`, `CLUSTER_WINDOW_HOURS` | `0.42`, `72` | Story-grouping similarity threshold and time window. |

Empty values count as unset, so Compose can pass `${AI_MODEL:-}` safely.

## Request shape (Anthropic)
- Official SDK (`@anthropic-ai/sdk`, pinned). SDK retries are disabled (`maxRetries: 0`), so the job queue owns retry policy and accounting.
- The system prompt is versioned (`article-analysis@1`, `multi-summary@1`) and marked cacheable (`cache_control: ephemeral`).
  At worker start, prompt texts are hashed and registered in `ai_prompt_versions`. If a prompt text changes without a
  version bump, the worker refuses to start.
- Structured output: a JSON schema generated from the Zod contract in `analysis/schemas.ts`. The response is parsed and
  validated locally. Invalid JSON or schema violations are `invalid_output` (retryable). A refusal (`stop_reason: refusal`)
  is terminal and is not retried; the fallback applies. Truncation (`max_tokens`) is `invalid_output`.
- Source text is wrapped in nonce-tagged `<source_document>` blocks. Forged closing tags are neutralised. The system prompt
  states that the content is untrusted data.

## Error categories
| Kind | Retried | Typical cause |
|---|---|---|
| `timeout`, `network`, `rate_limited` (honours `retry-after`), `server` (5xx / 529), `invalid_output` | yes | transient |
| `auth`, `invalid_request`, `refusal`, `unconfigured` | no → fallback or failed | configuration or content |

Errors are classified with the SDK's typed exception classes, not by matching message text.

## Cost accounting
- Every provider call writes an append-only `ai_usage_records` row: tokens in, tokens out, cache reads, provider, model and purpose.
- **Prices are not shipped with the code.** A platform administrator sets them per provider and model:
  `PUT /api/v1/platform/ai/pricing/{provider}/{model}` with `{ inputPerMtok, outputPerMtok, cacheReadPerMtok?, currency, source }`
  (audited). The `source` field records where the price came from.
- Without a configured price, cost is shown as "not available", never as zero. With a price, the estimate stores the price
  timestamp used. Estimates are not invoices.
- Per-organization limits (Administration → AI analysis): daily analysis count and monthly tokens. They are checked when a job
  starts, and a job over a limit is recorded as `quota_exceeded` without calling the provider. New records can be excluded
  from automatic analysis (`auto_analyze`).

## Outage behaviour
Ingestion never waits for analysis. New records are queued only after the ingestion transaction commits; if the queue is
unavailable, the run records `queue_analysis: queue_unavailable` and collection still succeeds. During a provider outage,
jobs retry with backoff. After the final attempt, the baseline result is stored as `partial`, with the reason in the
processing record, unless `AI_FALLBACK=none`.

## Reprocessing
- `POST /organizations/:org/mentions/:id/reprocess` requires `analysis:reprocess` (owner, admin, project manager). It is
  audited, limited to 30 requests per minute per organization, and repeat clicks within a minute collapse into one job (409).
- `POST /organizations/:org/analysis/backfill` with `scope` = `pending` | `stale` | `failed`. *Stale* means analysed, or
  skipped, under a different processing configuration (pipeline, provider, model, prompt or taxonomy version).
- Earlier results are kept. Only the newest successful analysis is "current".

## Adding a provider
Implement `AnalysisProvider` (`analysis/providers/provider.ts`): `analyzeArticle` and `summarize`, returning output that matches
the Zod schemas plus token usage. Throw `ProviderError` with a kind from the table above, and register the provider in
`providers/index.ts`. Output still goes through `sanitizeArticleAnalysis` / `sanitizeMultiSummary`; providers are never trusted.
