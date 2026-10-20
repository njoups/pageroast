# Social listening connectors

> **Verification status (2026-10-20).**
> - The framework and the **YouTube Data API v3** connector are implemented and pass contract tests against a local mock of the documented API.
> - **No connector has been verified against a live provider.** No YouTube API key (or other provider credential) was available in this environment.
> - An unauthenticated request to the real endpoint was answered with HTTP 403 (`reason: forbidden`, "unregistered callers"). That confirms the endpoint is reachable from here and the error envelope matches what the connector parses. It is not a live verification.
> - All other providers are listed with what they would require; none has a connector.

## 1. How it fits the platform

A social connector **is a source** of a social kind (`connectors.kind = 'youtube'`). It reuses everything a news source has:
- the source registry (authorization basis and status, permitted fields, retention, attribution, licence terms);
- encrypted credentials (`connector_credentials`, AES-256-GCM with `CREDENTIALS_KEY`);
- the ingestion queue and scheduler, the run ledger (`connector_runs`) and health;
- the pipeline: validate → normalise → deduplicate → match project queries → persist → queue analysis;
- AI analysis, clustering, the deletion workflow, retention and the audit log.

What is social-specific:

| Piece | Where | What it adds |
|---|---|---|
| Provider descriptors | `apps/api/src/social/providers.ts` | Capability matrix: operations, fields, metrics, limits, quotas, pricing model, data rights, limitations, documentation links and read date. The API and UI render it. |
| Connector interface | `ingestion/connectors/connector.ts` | Optional `estimateSyncUsage`, `refresh`, `testConnection`, `apiHost`. Records may carry `social` fields. Results and errors carry a `UsageReport` per quota bucket. |
| YouTube connector | `ingestion/connectors/youtube.connector.ts` | Keyword search, channel monitoring, optional public comments, refresh by id, connection test |
| Quota and budgets | `social/quota.ts` | Provider quota state per provider day, pre-flight checks, budgets (warn/soft/hard), pauses, cost estimates from configured pricing |
| Rights gate | `social/rights.ts` | Whether derived analysis may run (`requires_approval` needs a recorded approval) |
| Lifecycle job | `social/lifecycle.service.ts` | Refresh-or-delete obligations, every 15 minutes in the worker |
| API | `social/social.controller.ts` | `/api/v1/organizations/:orgId/social/...` (section 7) |
| Analytics | `social/social-analytics.ts` | Social-only analytics with stated denominators (section 6) |
| UI | `apps/web/src/app/o/[orgId]/social/page.tsx` | Connectors, analytics, mentions, provider matrix, budgets |

## 2. Provider capability matrix

Read from official documentation on **2026-10-20** unless stated otherwise. Nothing below was guessed. Where documentation could not be read, the entry says "unverified".

| | YouTube Data API v3 | X API v2 | Reddit Data API | Meta Content Library | Licensed provider |
|---|---|---|---|---|---|
| Connector | **Implemented** (contract-tested) | Not built | Not built | Not applicable | Not built |
| Live-verified | No (no API key) | No | No | No | No |
| Access | API key (public data) | Developer account, App, pay-per-use credits | Unverified (docs returned HTTP 403) | Approved research only (ICPSR/CASD); Secure Research Environment | Contract |
| Authentication | API key; sent as `X-Goog-Api-Key` header | Bearer token (app) | OAuth 2 (unverified) | n/a | per contract |
| Content | Videos, live streams, public comments | Posts | — | Facebook/Instagram public content (research) | per contract |
| Search | Keyword search (`search.list`, `q` supports `-` and `\|`); channel uploads; no hashtag endpoint | Recent search (7 days); full-archive (pay-per-use, Enterprise) | — | Research UI/API only | per contract |
| History | `publishedAfter`/`publishedBefore`; results capped (≈500 per channel search); non-relevance order may be incomplete | Recent: 7 days. Archive: from March 2006 | — | — | per contract |
| Metrics | viewCount, likeCount, commentCount, favoriteCount; comments: likeCount, totalReplyCount (as returned; hidden counts absent) | not reviewed | — | — | per contract |
| Quota | `search.list`: separate bucket, **100 calls/day** default. Other methods (videos, channels, playlistItems, commentThreads, comments): **1 unit each**, **10,000 units/day**. Reset midnight **Pacific Time**, per Google Cloud project. | Pay-per-use cap: 3 million post reads per billing cycle | — | — | per contract |
| Price | Quota-based; no per-request price found. Extensions need an API Compliance Audit. | **$0.005 per post read**; Counts: Recent $0.005 per request | — | — | per contract |
| Storage | Non-Authorized (public) data: limited amounts, **≤ 30 days**; statistics ≤ 30 days (III.E.4.b/d) | not reviewed | — | Export restricted | per contract |
| Refresh / deletion | Refresh or delete within 30 days; user-requested deletion within **7 days** (III.E.4.g) | not reviewed | — | — | per contract |
| Derived analysis | **Prohibited** by III.E.4.h unless the **derived-metrics amendment** is accepted (Section 5 "Analytics & Reporting"). That amendment allows viewer sentiment analysis and content tagging; derived metrics must be labelled and kept distinct from YouTube data. | not reviewed | — | Inside Meta's environment only | per contract |
| Aggregation | Restricted (III.E.2: no aggregation for insights into YouTube's business; cross-owner aggregation limited) | not reviewed | — | — | per contract |
| Redistribution | Must not sell, redistribute or sublicense (III.G.1.a) | not reviewed | — | Research outputs only | per contract |
| Required from customer | Google Cloud project, API key restricted to YouTube Data API v3; optional derived-metrics acceptance | Developer account, credits, terms review | Terms review | Not usable for commercial monitoring | Procurement and legal review |

Sources:
- YouTube: [quota costs](https://developers.google.com/youtube/v3/determine_quota_cost) (updated 2026-10-15), [search.list](https://developers.google.com/youtube/v3/docs/search/list) (updated 2026-10-15), [Developer Policies](https://developers.google.com/youtube/terms/developer-policies) (updated 2026-10-15), [derived-metrics policy](https://developers.google.com/youtube/terms/derived-metrics-policy) (updated 2026-09-14).
- Google: [system parameters / X-Goog-Api-Key](https://docs.cloud.google.com/apis/docs/system-parameters) (updated 2026-10-14).
- X: [pricing](https://docs.x.com/x-api/getting-started/pricing) and [search](https://docs.x.com/x-api/posts/search/introduction), read 2026-10-20 (no page date shown).
- Meta: [Content Library and API](https://developers.facebook.com/docs/content-library-and-api), read 2026-10-20.
- Reddit: the [Data API wiki](https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki) returned HTTP 403 from this environment.

**Not covered:** TikTok, Facebook/Instagram commercial monitoring and Threads. No authorized route for commercial keyword monitoring of their public content was identified in the documentation read; a licensed aggregator under contract is the realistic path.

### Prioritization
YouTube was implemented first because it:
- is heavily used by Indonesian ministries, regional governments and media;
- has documented public-data access with a free API key and a published quota model, which makes it reliable to operate;
- has keyword and date-range search;
- explicitly permits commercial use under its terms.

Its constraints (30-day storage, approval for derived analysis, small search quota) are severe but implementable, and are implemented.

X is the next candidate: high relevance, paid but documented access. It needs a review of the Developer Agreement and its deletion-compliance duties before any build. Meta and TikTok coverage needs a licensed provider.

## 3. The YouTube connector

### Configuration (`config`, validated; unknown keys rejected)
| Setting | Default | Notes |
|---|---|---|
| `mode` | `search` | `search` (keyword) or `channel` (up to 20 channel ids `UC…`) |
| `query` | — | 2–200 characters; search mode only. Project queries are matched after collection, as for news. |
| `channelIds` | `[]` | Channel mode only |
| `regionCode` / `relevanceLanguage` | `ID` / `id` | Passed to `search.list` |
| `lookbackHours` | 48 | `publishedAfter = now − lookback` (1–720) |
| `maxResults` / `maxPages` | 25 / 1 | Per page ≤ 50; pages per sync ≤ 4 |
| `includeComments` | false | Public top-level comments of the newest `maxVideosForComments` (≤ 10) videos, `maxCommentThreads` (≤ 100) each |
| `quotaPerDay` | `{search: 100, units: 10000}` | Raise only when the Google Cloud project has an approved extension |

The API key is **not** part of `config`. It is stored through `PUT …/credentials`, encrypted, never returned (only a `…last4` hint) and never logged.

### Requests per sync (worst case, checked before the sync starts)
- **Search mode:**
  - `maxPages` × `search.list` (search bucket);
  - 1 `videos.list` per 50 ids (`part=snippet,statistics`);
  - plus 1 `commentThreads.list` per video when comments are on.
- **Channel mode:**
  - 1 `channels.list` (uploads playlist);
  - per channel, up to `maxPages` `playlistItems.list` plus `videos.list` calls;
  - plus comments as above.

### Normalisation (only what the provider returned)
| Field | Video | Comment |
|---|---|---|
| URL | `https://www.youtube.com/watch?v={id}` | `…watch?v={videoId}&lc={commentId}` |
| `external_id` / `parent_external_id` | video id / — | comment id / video id |
| `content_type` | `video` or `live_stream` (from `liveBroadcastContent`) | `comment` |
| Title / excerpt | title / description (≤ 1,000 characters, if `excerpt` is permitted) | first 200 characters of the text / full text |
| Author | channel title (`author` permitted only) | display name (`author` permitted only) |
| `author_ref` | channel id (`author` permitted only) | author channel id (`author` permitted only) |
| Hashtags | `#tags` written in title/description (Unicode; not URL fragments or HTML entities) | written in the text |
| `engagement` | numeric statistics present in the response (`metrics` permitted only); hidden counts stay **absent**, never 0 | likeCount, totalReplyCount |
| Language | `defaultLanguage` / `defaultAudioLanguage` if given | none (detected by the analyser; undetectable short text is skipped as `unsupported_language`) |

Shorts cannot be told apart from ordinary videos in the data requested, so they are not labelled `short_video`.

**Deduplication:** by provider id (`(tenant, platform, external_id)` unique) and canonical URL. Title-similarity duplicate detection is **off** for social records, because different posts often share a title. A record seen again in a later sync is a refresh: text, metrics and deadlines are updated in place.

### Errors
| Provider answer | Kind | Behaviour |
|---|---|---|
| `quotaExceeded` / `dailyLimitExceeded` | `quota` | Not retried; connector paused until the Pacific-Time reset; notice recorded |
| `rateLimitExceeded`, HTTP 429 | `rate_limited` | Retried with backoff; counted in usage |
| `keyInvalid`, "API key" 400 | `auth` | Not retried; message never contains the key |
| `accessNotConfigured` | `forbidden` | "Enable YouTube Data API v3 for the project" |
| `commentsDisabled` on one video | — | Recorded as a rejection; the sync continues |
| 5xx, network, timeout | `server`/`network`/`timeout` | Retried |

401/403 are never retried or worked around. Only public resources are requested.

## 4. Data rights and lifecycle

Each social connector stores a **rights snapshot** (`connectors.rights`) copied from its descriptor: `storageMaxDays`, `refreshWithinDays`, `deletionOnRequestDays`, `derivedAnalysis` and `metricAggregation`.

- **Retention cap:** a connector's `retentionDays` can't exceed the provider's `storageMaxDays` (YouTube: 30). The API refuses longer values.
- **Deadlines per record:**
  - `provider_delete_by` = retrieval + 30 days;
  - `refresh_due_at` = retrieval + 25 days (a 5-day margin for retries).

  Both restart whenever the record is retrieved again.
- **Lifecycle job (worker, every 15 minutes):**
  1. Records with `refresh_due_at` passed are re-read (`videos.list` / `comments.list` by id, 1 unit per 50).
     - Still available: text, metrics (as of the refresh) and deadlines are updated.
     - **No longer returned** (deleted, made private, removed): purged with everything derived from them (`governance/purge.ts`).
  2. Records past `provider_delete_by` are purged. This happens when they could not be refreshed in time because the authorization was revoked, credentials were removed, or quota ran out.
  3. Under a **legal hold**, nothing is deleted. The overdue count is recorded as `blocked_by_legal_hold`, audited (`social.lifecycle_blocked_by_legal_hold`, outcome `denied`) and shown on the connector. Counsel must decide how to reconcile the hold with the provider obligation.
  4. Every run with activity writes `provider_lifecycle_runs` and an audit event (`social.lifecycle_purged`).
- **Purging** removes the records, their analyses, matches, cluster membership and report citations. Report files citing them are expired (410), AI summaries using them are deleted, and the analytics cache is invalidated. Search indexes live in the row and go with it.
- **Deletion requests** (four-eyes, `/deletion-requests`) work for social records as for news (scope `mentions`, `source` or `search`).
- **What we cannot remove:** files users already downloaded, emails already sent, webhook payloads already delivered, and copies in database backups until those backups expire (BACKUP_AND_RECOVERY.md).

### Derived analysis (AI)
- **Default:** YouTube's `derivedAnalysis` is `requires_approval`, so new YouTube records are **not** queued for AI analysis.
- **Backfill and reprocess:** these are refused per record with `content_status = 'not_permitted'`.
- **Approving:** an owner or admin (`ai:settings`) records the approval with `PUT …/derived-analysis-approval {approved: true, reference}`. The reference is the acceptance of the derived-metrics amendment. The approval is audited and can be revoked.
- **After approval:**
  - Results are labelled in the UI as "CivicSignal estimate" and stored separately from provider data (`sentiment_results`, not `engagement`).
  - Analysis rows record `source_category = 'social'`, `platform` and `content_type`.
- **What the analyser is told:** each record says whether it is a post or a comment. Short text, sarcasm, slang and quoted speech should lower confidence. Commenters are private individuals and are never listed as entities. Engagement must not be inferred.
- **Content status:** posts under 40 characters are analysed with `content_status = 'short_text'`, and a non-neutral tone is marked uncertain. Text whose language cannot be detected is skipped (`unsupported_language`).
- **Prompt injection:** social text is wrapped as untrusted content exactly like news. The analyser's output can't trigger tools, queries or permissions, and every quote is checked against the stored text (AI_PROVIDERS.md).

## 5. Quota, usage and cost

- **Usage:**
  - Every provider request is counted per connector, provider day (YouTube: Pacific Time) and bucket in `provider_usage`, with requests, units, records retrieved and rejected, and rate-limit responses.
  - Failed calls are counted too.
  - Storage (rows and approximate bytes) and AI processing (analyses and tokens) are reported per connector.
- **Pre-flight check:** before each sync, the connector's worst-case usage is compared with what is left today. If it doesn't fit, nothing is sent and the connector **pauses** until the reset (`paused_reason = provider_quota`). Scheduled runs are skipped silently while paused; a manual sync gets 409 `connector_paused`.
- **Provider-reported exhaustion** (`quotaExceeded`) pauses the same way.
- **Budgets** (`PUT /social/budgets`), per tenant or per connector, per day or month, on `quota_units`, `requests`, `records_retrieved` or `estimated_cost`:
  - **warn:** a notice;
  - **soft:** scheduled syncs pause, manual syncs still run;
  - **hard:** all syncs stop until the period ends.

  Each level reached is recorded once per period (`social_budget_events`), shown on the connector and in Budgets, and can be acknowledged.
- **Recovery:** pauses end at the reset or period end. A successful sync clears an expired pause.
- **Cost estimates:**
  - Come only from `provider_pricing` rows (provider, item, unit price, currency, **source URL, verification date**), maintained by operators as the database owner. No prices are in code.
  - Without rows the estimate is `not_priced` and no figure is shown.
  - If a charged item has no usage counter, the estimate is `incomplete` and no total is shown.
  - YouTube is quota-based; no price was found in its documentation, so it shows "Not priced".
- **Shared quota (limitation):** YouTube quota belongs to the Google Cloud project. Several connectors using the same key share one quota, but each tracks only its own usage. Give each connector its own key, or set `quotaPerDay` to the share it may use.

## 6. Analytics (`GET /social/analytics`)
Social analytics are separate from the executive Analytics page:
- Executive analytics, reports, dashboard aggregates and alert rules use **news articles only** by default (`channel=news`). Social records enter them only when explicitly requested: `channel=social|all` on analytics, `filters.channels: ['news','social']` on alert rules.
- Mention search returns both channels, labels each item, and filters with `channel`, `platform`, `contentType` and `hashtag`.

| Section | Definition (denominator) |
|---|---|
| Volume by platform and content type | Records of the platform and type ÷ all social records in the period |
| Trend | Records per bucket, per platform |
| Record-level tone | Per platform **and** content type (video vs comment). Shares use confidently labelled records of that group as the denominator; uncertain, unanalysed and not-permitted records are counted separately. News-article tone is never mixed in. |
| Conversation-level tone | Distribution of comment tones under one video (≥ 3 analysed comments). It is not a single verdict on the conversation. |
| Entity tone | From the AI model path's entity sentiments (`target_type = 'entity'`), shown with the source channel |
| Hashtags | Records with the tag ÷ records with any hashtag |
| Topics | Records with the topic ÷ analysed social records (a record can have several topics) |
| Engagement | Per metric: records with and without it. For providers whose terms restrict aggregation (YouTube), **only per-record values as returned**, with the time observed: no sums, averages or medians, and never a cross-platform "engagement score". |
| Accounts/channels | Distinct account ids among posts (only when `author` is permitted) |
| Cross-platform entities | Records mentioning the entity, news vs social, counted separately |
| Issue timeline (`GET /social/issues/:id/timeline`) | Per day: the issue's evidence plus records in the same story clusters, by channel (news, youtube, …) |

Views and likes are not reach, impressions or audience size. Volume and engagement show attention among collected records, not public opinion or consensus.

## 7. API (`/api/v1/organizations/:orgId/social`)
| Method and path | Permission | Purpose |
|---|---|---|
| `GET providers` | sources:read | Capability matrix |
| `GET connectors`, `GET connectors/:id` | sources:read | Status, credentials (configured/hint only), quota, rights, lifecycle, notices, capabilities |
| `POST connectors` | sources:manage | Create (validated against provider limits; starts disabled) |
| `PATCH connectors/:id` | sources:manage | Name, config, authorization, permitted fields, refresh interval, retention (≤ provider max) |
| `PUT` / `DELETE connectors/:id/credentials` | sources:manage | Set (reauthorize) or remove the key |
| `POST connectors/:id/test` | sources:manage | One authorized call; 5 per connector per 10 minutes |
| `POST connectors/:id/sync` | sources:manage | Queue a sync (409 when paused or unconfigured) |
| `POST connectors/:id/enable` / `disable` | sources:manage | Scheduled collection |
| `GET connectors/:id/health` | sources:read | Connector, last 20 runs, lifecycle runs |
| `GET connectors/:id/usage?days=` | sources:read | Usage per day and bucket, totals, storage, processing, cost status |
| `PUT connectors/:id/derived-analysis-approval` | ai:settings | Record or revoke the approval |
| `GET` / `PUT budgets`, `DELETE budgets/:id`, `POST notices/:id/acknowledge` | sources:read / sources:manage | Budgets and notices |
| `GET mentions` | mentions:read | Social records (project visibility applies), paginated, filterable |
| `GET analytics` | mentions:read | Section 6 |
| `GET issues/:issueId/timeline` | alerts:read | Cross-platform issue timeline |

All routes are tenant-scoped: non-members get 404, other tenants' ids get 404, and RLS applies. Connector changes, tests, approvals and budgets are audited.

## 8. Security
- **Credentials:** server-side only. Encrypted at rest, sent in a header (`X-Goog-Api-Key`) and never in URLs, never returned, logged or echoed in errors (tests check responses, audit metadata and stored ciphertext).
- **Least privilege:** the key needs only the YouTube Data API v3. Restrict it to that API and to the worker's egress IP. Public data needs no OAuth scopes.
- **OAuth:** not used by any implemented connector. The YouTube connector reads public data with an API key, so OAuth state validation and token refresh/revocation are **not applicable** and were not built. A connector for authorized (owner) data would need them.
- **Outbound requests:** go through `SafeHttpClient` (private/metadata ranges blocked, size and time limits). The API base URL is fixed. `YOUTUBE_API_BASE_URL` exists for contract tests only and is refused in production.
- **Untrusted content:** all social content is untrusted (section 4, prompt injection).
- **Isolation:** the new tables (`provider_usage`, `social_budgets`, `social_budget_events`, `provider_lifecycle_runs`) have forced RLS with tenant policies. `provider_pricing` is platform reference data: read-only for the app, maintained by the owner role.
- **Rotation:** to rotate a provider key, `PUT …/credentials` with the new key, `POST …/test`, then revoke the old key in Google Cloud. `CREDENTIALS_KEY` rotation is in RUNBOOK.md.

## 9. Setting up YouTube (customer or operator)
1. Create a Google Cloud project, enable **YouTube Data API v3**, and create an API key restricted to that API and to the worker egress IP.
2. In **Social listening → Add connector**, enter the query or channel ids, the key, and the authorization basis (for example "YouTube API Services Terms accepted for project X on date Y; purpose: public-information monitoring"). Tick "authorized".
3. **Test connection** (uses 1 unit), then **Sync now**. Check the sync history and records, then **Enable schedule** (minimum interval 1 hour). Mind the 100 search calls/day.
4. Optional: accept the derived-metrics amendment with Google (Section 5, "Analytics & Reporting"), then record the reference under the connector's data rights. AI analysis starts for new records; use reprocess for earlier ones.
5. Optional: set budgets.

## 10. Testing and live-verification status
| Test | What it proves | Kind |
|---|---|---|
| `test/unit/social/youtube.spec.ts` (27 tests) | Config validation, header-only key, request sequence, quota accounting per bucket, normalisation, missing metrics, hashtags, error mapping, refresh, connection test, quota day (DST), descriptor consistency | Unit, mock HTTP |
| `test/integration/social.e2e.ts` (12 tests) | Full API + pipeline + analysis + lifecycle + PostgreSQL against a **local mock** of the YouTube API: catalogue, validation and permissions, credential secrecy, test endpoint and rate limit, sync with platform fields, refresh-on-reseen, approval gate, news/social separation, quota pauses, budgets, cost status, lifecycle refresh/purge/legal hold, tenant isolation (API and DB) | Integration, mock provider |
| `apps/web/src/lib/social.test.ts` | Status precedence, quota/cost/share rendering, form-to-config mapping, permissions | Unit |
| Live | **Not run: no API key available.** | — |

**Blocker for live verification:** a YouTube Data API key in a Google Cloud project the customer or operator controls.

With a key:
1. Set the key on a connector in staging.
2. Run Test connection and one sync.
3. Confirm that the header authentication is accepted. If not, the connector must be changed to the `key` query parameter, with URL redaction.
4. Confirm the record count against the YouTube UI.
5. Then set `liveVerified: true` in `providers.ts` with the date.
