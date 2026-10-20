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

## Retention
`retention_policies` stores per-tenant, per-data-class retention. Defaults are conservative; enforcement jobs arrive in M6.
Retention may be shortened by a source licence but never lengthened beyond it.
Report runs keep the ids of cited records. When record retention is enforced (M6), deleting a record also removes it from
`report_run_sources` (cascade); the stored report model keeps only the headline, publisher and URL it quoted.

## Source licence registry
The `sources` table (with `connectors`) is the registry. No source is seeded. Operators enter the authorization basis.
The two RSS sources used for live verification in the development database were marked authorized *for a limited integration test only*.
Their basis text says so, and their publishers' terms have **not** been reviewed (see CONNECTORS.md).

## Open items for legal review
UU PDP applicability to public-figure mentions and extracted names · hosting location · cross-border transfer of source text to an AI provider and the provider's retention terms · whether sending licensed excerpts to an AI provider is permitted by each source licence · publisher terms for RSS reuse and excerpts.
