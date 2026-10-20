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
| Derived | sentiment, entities, topics, summaries, story clusters | stored with method, model/prompt/taxonomy versions, confidence and evidence; history kept |
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

## AI analysis controls (implemented in Milestone 3)
- **Estimates, labelled as such.** Every classification and summary stores its method (`llm`, `baseline`, `test`), provider, model,
  prompt version, taxonomy version, confidence and evidence. The UI shows the method beside each result and separates source content,
  automated classifications, generated summaries and processing records. Test-fixture output is refused in production.
- **Evidence or nothing.** Entities, tone evidence, topic cues and quoted summary claims must occur verbatim in the permitted source text.
  Otherwise they are discarded. Summaries cite the records behind each claim, mark interpretation separately from reported content, and
  say "insufficient evidence" instead of speculating. Syndicated copies are not counted as independent corroboration.
- **No personal profiling.** Prompts forbid inferring sensitive attributes (religion, ethnicity, health, political affiliation of
  private individuals, etc.). Public figures are extracted only as named in coverage. No per-person scores or risk profiles exist in
  the schema. Sentiment is about the text's tone toward a target, not a judgement of a person.
- **Language honesty.** Only Indonesian and English are analysed. Other languages and undetermined text are skipped and labelled, never
  silently treated as Indonesian.
- **Only permitted fields leave the system.** With an AI provider configured, the provider receives only the stored, licence-permitted
  fields (headline, excerpt, body if permitted) and project category names. Account data, analyst input and other tenants' data are
  never sent. Provider data-handling and cross-border transfer need legal review (open item below).
- **History.** Re-analysis creates a new analysis; earlier results are kept. Cluster membership changes and usage records are append-only.

## Analytics and report controls (implemented in Milestone 5)
- **Deterministic figures only.** Every metric in dashboards and reports is computed in SQL from stored records. Language
  models never produce numbers. Optional AI commentary must cite the report's records, may only use the report's own metric
  values or numbers present in those records, and must not state causes, public opinion, effectiveness or forecasts. It is
  labelled as interpretation.
- **Typed statements.** Reports mark each paragraph as a calculated metric, an observed source fact, an AI interpretation or an
  analyst recommendation, and list methodology and limitations.
- **No profiling.** Analytics aggregate coverage by publisher, topic and named entity as reported in the media. Nothing scores
  or profiles citizens or individuals, and nothing measures public opinion.
- **Licence-aware exports.** PDFs contain headlines, publishers, dates and links only. CSV exports always contain title and URL.
  They contain the excerpt only when the source permits the `excerpt` field and has no redistribution restriction, and never
  the article body. Each omission is explained in an `excerpt_omitted_reason` column.
- **Access.** Reports follow project access. Downloads require authentication and are audited; there are no public links.
  Emails carry a link, never the file or figures. Recipients are re-checked at every delivery.
- **Retention.** Report files are deleted after `REPORT_ARTIFACT_TTL_DAYS` (default 30), keeping metadata and checksums. The run
  record (model, metrics, cited record ids) remains as history. Analytics cache entries expire after 15 minutes and are purged
  hourly.

## Retention, legal hold and deletion (implemented 2026-10-20)
Retention is **off until a tenant enables it** (`PUT …/data-governance/controls { retentionEnabled: true }`, `retention:manage`). Nothing is deleted by default. The applicable legal retention duties (archives, public-information, sector rules) and licence terms must be checked with counsel before a tenant turns it on.

**Policies** (`PUT /organizations/:orgId/data-governance/retention-policies/:dataClass`, `retention:manage`):

| Data class | Effect when older than N days |
|---|---|
| `mention_body` | Article body cleared; metadata, matches and analysis kept |
| `mention_metadata` | Record deleted with everything derived from it (see purge below) |
| `derived_analysis` | Superseded (non-current) analyses and summaries deleted; current ones kept |
| `reports` | Report runs and their files deleted |
| `audit_events` | **Not deleted**: must be ≥ 365 days; reported only (SECURITY.md, audit log) |
| source licence | Always applied when retention is enabled: records past their source's `retention_expires_at` are deleted. A licence can shorten retention, never lengthen it. |

**Execution:**
- The worker runs each tenant at most daily, under an advisory lock.
- `POST …/retention/preview` returns exact counts without changing anything. `POST …/retention/apply` (`data:delete`) runs it now.
- Each run writes a `retention_runs` ledger row and an audit event (`retention.applied`, `retention.previewed` or `retention.skipped`).
- Records cited as evidence by an **open issue** are kept until the issue closes.
- Work is done in batches of 2,000 per class per run.

**Legal hold** (`PUT …/data-governance/controls { legalHold: true, legalHoldReason }`):
- stops all retention purges and blocks deletion requests for the tenant;
- is audited (`data_controls.updated`);
- does not stop collection.

**Deletion requests** (`/organizations/:orgId/deletion-requests`, `data:delete`, owners only):
1. Request a scope: specific mentions (≤ 1,000 ids), everything from one source, or a full-text search. A reason is required. The request resolves the scope to record ids **at request time**, at most 20,000; larger scopes must be split or handled by retention.
2. **Four-eyes:** a *different* owner approves. A sole owner must pass `confirmSelfApproval: true`, which is recorded.
3. On approval, the records are purged and the request becomes `completed` (`deletion.completed`). Requests can be rejected or cancelled while pending.

**Purge** (`governance/purge.ts`), for both retention and deletion requests:
- expires report files that cited the records (download → 410) and appends a limitation note to those runs;
- deletes AI summaries that used them and clears issue AI summaries;
- deletes the mentions (cascading matches, analyses, entities, topics, sentiment, cluster membership, report citations);
- recomputes or dissolves clusters;
- invalidates analytics aggregates and drops the analytics cache.

**Limits (stated to requesters):**
- Deletion acts on the **live database only**. Copies remain in backups until those backups expire (BACKUP_AND_RECOVERY.md, backups and deletion). After a restore, executed deletions must be re-applied.
- Files users already downloaded, emails already sent and webhook payloads already delivered are outside the system's control.
- Audit events keep the ids and counts of what was deleted, never the content.

Report runs keep the ids of cited records. Deleting a record also removes it from `report_run_sources` (cascade). The stored report model keeps only the headline, publisher and URL it quoted.

## Social platform data (implemented 2026-10-20)
Full detail: [SOCIAL_CONNECTORS.md](SOCIAL_CONNECTORS.md), sections 2 and 4.

- **Permitted collection:** public content reachable with the customer's own API key, within the provider's terms. No
  private accounts, no scraping, no bypassing quotas or access controls. 401/403 are never worked around.
- **Permitted storage:**
  - Each connector carries the provider's rights snapshot. YouTube: at most 30 days per record unless refreshed; statistics at most 30 days.
  - Records carry `provider_delete_by` and `refresh_due_at`, and the lifecycle job refreshes or deletes them (records gone at the provider are purged).
  - Connector retention can't exceed the provider limit.
- **Permitted fields:** title, link and time by default, plus excerpt and metrics. Author names and account ids are off by default.
  Public comments are off by default; they are personal data of private individuals, so check the legal basis before enabling.
- **Derived analysis:**
  - YouTube forbids derived metrics unless the derived-metrics amendment is accepted, so AI analysis of YouTube records runs only
    after an owner/admin records that approval.
  - Results are labelled as CivicSignal estimates and stored apart from provider data.
  - Commenters are never extracted as entities.
- **Redistribution:** YouTube API data must not be sold, redistributed or sublicensed. Social records are excluded from reports
  by default (reports cover news); exports carry links, not copies of video data.
- **Metrics:** only metrics the provider returned, with the time they were observed. They are not summed across records or
  platforms where the provider restricts aggregation, and are never presented as reach, impressions or public opinion.
- **Legal hold vs provider deletion duty:** a legal hold stops the lifecycle job from deleting; the overdue records are counted,
  audited and shown. Counsel must decide which obligation prevails.
- **Customer visibility:** the social workspace shows each provider's coverage, limitations, verification date and data rights.

## Source licence registry
The `sources` table (with `connectors`) is the registry. No source is seeded. Operators enter the authorization basis.
The two RSS sources used for live verification in the development database were marked authorized *for a limited integration test only*.
Their basis text says so, and their publishers' terms have **not** been reviewed (see CONNECTORS.md).

## Open items for legal review
UU PDP applicability to public-figure mentions and extracted names · processing of public social comments (personal data of private individuals) and the lawful basis for monitoring them · reconciling legal holds with provider deletion obligations (YouTube 30-day limit) · hosting location · cross-border transfer of source text to an AI provider and the provider's retention terms · whether sending licensed excerpts to an AI provider is permitted by each source licence · publisher terms for RSS reuse and excerpts.
