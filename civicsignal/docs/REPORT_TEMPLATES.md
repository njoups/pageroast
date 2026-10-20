# Report templates and generation

Reports are generated from stored data by `apps/api/src/reports/`. Templates are code-defined and versioned
(`report-templates/1`). Every run records the template version, the period, the time zone, the metrics snapshot, the
rendered model, its limitations and every record it cites (`report_run_sources`).

## Templates
| Template | Default period | Contents |
|---|---|---|
| **Daily Media Briefing** (`daily_briefing`) | Previous local day | Summary KPIs, coverage per day, tone (counts, shares, limitations), top topics, active issues, cited coverage (largest story clusters) |
| **Weekly Media Intelligence** (`weekly_intelligence`) | Previous ISO week (Mon–Sun) | Everything in the daily briefing, plus share of voice, rising topics, entities and co-occurrence, publishers and diversity, negative-tone coverage, optional AI commentary |
| **Monthly Communications Performance** (`monthly_performance`) | Previous calendar month | Same sections as the weekly report, against the previous month. It describes media coverage only: volume, tone distribution and share of voice. **It is not a measure of communication effectiveness.** |
| **Issue & Crisis Report** (`issue_report`) | 7 days (or as requested) | With `issueId`: severity, status, detection basis and limitations, evidence per day, lifecycle history, supporting records. Without it: all issues active in the period. Plus coverage and tone, and negative-tone coverage. The focus issue's evidence and history are shown in full, even where they fall outside the report period. The period figures (coverage, tone, issue counts) cover the period only. |
| **Policy & Public Program Monitoring** (`policy_monitoring`) | 30 days | Coverage and tone, share of voice among the selected programmes/policies (`entityIds`), one section per programme (articles, tone of articles mentioning it, recent records), topics, publishers. **It is not a measure of policy outcomes or public opinion.** |

Reports are written in Bahasa Indonesia or English (`language`), with locale number formats and dates in the run's time zone.

## Paragraph types
Every paragraph is labelled with one of five types, in the PDF, in the preview and in the stored model:
| Type | Meaning |
|---|---|
| Calculated metric | A deterministic figure from the analytics engine |
| Source fact | Headlines quoted as published, with their reference (`S1`, `S2`, …) |
| AI interpretation | Optional model commentary that passed validation (italic, with references) |
| Analyst recommendation | The analyst note entered on the definition, with author and date |
| Note | A definition, warning or limitation |

Template text never states causes, effectiveness or public opinion. A unit test scans every template in both languages for such wording.

## Evidence workflow
1. **Resolve scope.** The definition's project, the run's period and the time zone. Filters come from the definition parameters.
2. **Retrieve records** and **3. compute metrics** with the same engine as the dashboard, in one transaction (one snapshot).
4. **Select supporting records** by fixed rules:
   - one article per story cluster (the earliest), largest clusters first;
   - the most recent confident negative-tone articles;
   - issue evidence;
   - recent articles per programme.

   The number of records is bounded by `maxSources`.
5. **Optional AI commentary** is produced from those records only (titles and permitted excerpts). It is checked by
   `sanitizeMultiSummary` (references must map to supplied records) and by `validateCommentary`, which drops a claim when:
   - it cites no record the report cites (`no_valid_reference`);
   - it contains a number that is neither a report metric nor present in a cited record (`unsupported_number`);
   - it states a cause (`causal_claim`), public opinion (`public_opinion_claim`), effectiveness or success (`effectiveness_claim`), or a forecast (`forecast`);
   - it quotes text that does not occur verbatim in a cited record (`unverified_quotation`).

   Kept and dropped counts, and the reasons, are stored and printed under Limitations. Without a generative provider (the
   baseline), the report says that AI commentary is unavailable. Tokens are recorded in `ai_usage_records`, and the tenant's
   monthly token limit is respected.
6. **Validate references.** Every reference must resolve to a listed source, and every cited record must exist in the tenant and belong to the project.
7. **Validate metric consistency.** The cross-checks are:
   - tone counts (including unknown and unanalysed) = unique articles;
   - timeline total = unique articles;
   - publisher totals = unique articles;
   - share-of-voice shares sum to 100;
   - records ≥ articles.
8. **Render** the PDF and the CSV.
9. **Persist atomically**: artifacts, cited records, metrics, model, freshness, limitations, AI method and tokens, deliveries and audit.

If step 6 or 7 fails, the run **fails** with the reason. It is never rendered partially.

## PDF
pdfkit with the vendored Liberation Sans fonts (SIL OFL, `apps/api/assets/fonts`), covering Indonesian and English text.
- **Cover:** brand colour (organisation setting `brandColor`), organisation, project, period and time zone, generation time, template version, confidentiality note.
- **Content:** a header and "page x of y" footer on every content page; section headings; KPI tiles; tables with repeated
  headers across page breaks; vector bar and column charts (each with its values printed); the numbered source list
  (publisher, date, quoted headline, URL — links only for http(s)); methodology; limitations; source attribution.
- **Never included:** full article text and excerpts.

## CSV (articles in scope)
- **Columns** (stable order, `ARTICLE_COLUMNS`): `report_run_id, period_start, period_end, timezone, project, mention_id,
  published_at, collected_at, publisher, publisher_domain, title, url, language, sentiment, sentiment_uncertain, analysis_method,
  topics, entities, story_cluster_id, cited_in_sections, excerpt, excerpt_omitted_reason`. New columns are only ever added at the end.
- **Scope:** the scope is explicit in every row (run, period, time zone, project).
- **Format:** RFC 4180, every field quoted, CRLF line endings, UTF-8 with BOM, ISO 8601 UTC timestamps.
- **Formula injection:** cells starting with `= + - @`, a tab or a carriage return (after optional whitespace) get a leading `'`.
- **Licensing:** title and URL are always included. The excerpt is included only when the source permits the `excerpt` field
  and has no redistribution restriction; otherwise it is empty and `excerpt_omitted_reason` says why. **Article bodies are never exported.**
- **Row limit:** `REPORT_CSV_ROW_LIMIT` (default 5,000) per tenant export. Truncation is stated in the report limitations.

## Access, storage and retention
- **Downloads:** `GET /organizations/:org/reports/runs/:id/download/{pdf|csv}`, authenticated only. Access requires
  `reports:read` and access to the report's project (tenant isolation through RLS). There are no public or pre-signed links.
- **Response headers:** `Content-Disposition: attachment`, a sanitised ASCII filename, `Cache-Control: private, no-store`,
  `nosniff`, a sandbox CSP and a SHA-256 checksum. Every download is audited.
- **Expiry:** files are stored in `report_artifacts` and deleted after `REPORT_ARTIFACT_TTL_DAYS` (default 30) by the scheduler.
  The metadata (size, checksum, expiry) is kept, and the download then returns 410 `artifact_expired`.
- **History:** runs are never deleted by the application. Cited-source rows are append-only.

## Limits
| Limit | Default | Setting |
|---|---|---|
| Runs per tenant per 24 hours | 50 | `REPORT_RUNS_PER_DAY` |
| Queued + running runs per tenant | 3 | `REPORT_CONCURRENT_RUNS` |
| Generation attempts | 3 | `REPORT_ATTEMPTS` |
| Active schedules per tenant | 20 | — |
| Longest period | 366 days | `ANALYTICS_MAX_PERIOD_DAYS` |
| AI commentary tokens | the tenant's monthly AI token limit (`PUT ai/settings`); the provider's summary output limit applies per call | — |

Requests over a limit are rejected with HTTP 429 `quota_exceeded`. Scheduled runs over the daily quota fail with that reason and notify the owner.

## API
- `GET reports/templates`
- `GET|POST reports/definitions`, `GET|PATCH|DELETE reports/definitions/:id`
- `POST reports/definitions/:id/generate`: body `{periodStart, periodEnd}`, optional; header `Idempotency-Key`, optional
- `GET reports/runs`, `GET reports/runs/:id` (preview model), `POST reports/runs/:id/cancel`, `GET reports/runs/:id/download/:format`
- `GET reports/inbox`
- `GET|POST report-schedules`, `PATCH report-schedules/:id`, `POST report-schedules/:id/cancel`

All paths are under `/api/v1/organizations/:org/`. Definitions and generation require `reports:generate`, and reading requires
`reports:read`. Both also require access to the project.
