# Analytics methodology

Every analytics figure in CivicSignal is computed deterministically from stored records. No figure is estimated by a
language model. This document defines each metric, its denominator and its known limitations. The implementation is in
`apps/api/src/analytics/` (`engine.ts`, `metrics.ts`, `refresh.ts`, `tz.ts`) and the API is `GET /organizations/:org/analytics/*`.

## Units of count
| Term | Definition |
|---|---|
| **Record** (mention) | One collected item that matched at least one monitoring query of a project in scope. Duplicates and syndicated copies are included. |
| **Unique article** | A record whose `duplicate_status` is `original`, meaning it is not a duplicate or near-duplicate of an earlier record. Most metrics count unique articles. |
| **Publisher** | A distinct `publisher_domain` among unique articles. |
| **Source** | A registered collection source (one feed or connector). A publisher can have several sources. |
| **Story cluster** | A group of related articles across publishers (Milestone 3 clustering). Articles not yet clustered are reported separately. |

A record matched to two projects counts once in an organisation-wide view and once in each project view.

## Scope and access
- **Projects.** Owners and admins see every project. Other roles see only the projects they are assigned to, and asking for
  another project returns 404. Report viewers have no analytics access; they receive reports instead.
- **Tenant isolation.** All queries run under PostgreSQL row-level security for the caller's tenant.
- **Cache isolation.** Cache entries are keyed by the visible project set, so users with different visibility never share an entry.

## Time
- **Analytics time** = the publisher-reported `published_at`, or our `discovered_at` when the publisher gave no date. The
  number of undated articles is reported under *completeness*.
- **Periods** are half-open, **[from, to)**. A record at exactly `to` belongs to the next period. The default period is the last 30 local days ending at
  the next whole minute. The longest allowed period is 366 days (`ANALYTICS_MAX_PERIOD_DAYS`).
- **Buckets** are calendar days, ISO weeks (Monday) or calendar months in the **tenant time zone** (organisation setting
  `timezone`, default `Asia/Jakarta`). PostgreSQL converts the times, so half-hour zones and DST are exact. Every bucket in
  the period is listed, including empty ones (shown as 0, never skipped).
- **Granularity** defaults to day for periods up to 35 days, week up to 120 days, and month beyond that.
- **Previous period** is the window of equal length immediately before `from`.
- **Rolling comparisons** cover the last 1, 7 and 30 days ending at `to`, each against the equal window before it.

## Change
`change = current − previous`, and `pct = (current − previous) / previous × 100`. When the previous value is 0, `pct` is **null**,
shown in the UI as "(new)". We never present growth from zero as a percentage.

## Coverage (`/analytics/coverage`)
Reports totals for records, unique articles, duplicates, publishers, sources, story clusters and unclustered articles. Each comes with its change
against the previous period, the rolling comparisons and a timeline of unique articles and records per bucket.

## Sentiment (`/analytics/sentiment`)
- **Labels.** Each article carries the article-level label of its *current* analysis: positive, negative, neutral, mixed or unknown.
  Articles without an analysis are counted as `unanalysed`.
- **Shares** = label count ÷ (positive + negative + neutral + mixed). Unknown and unanalysed articles are **counted and shown
  but excluded from the denominator**. The denominator is reported as `denominator`.
- **Net tone** = positive share − negative share, in percentage points.
- **Uncertain share** = low-confidence labels as a share of known labels.
- **Breakdowns** by topic, by entity and by publisher cover the top 10 of each, with the same definitions. *By entity* is the tone of
  articles that mention the entity, which is **not** necessarily the tone toward the entity. Entity-targeted tone is shown
  separately under entities, and only where the analysis method produced it.
- **Limitations are always stated** when any of these hold:
  - fewer than 30 articles have a known label;
  - any article is unanalysed;
  - any label comes from the rule-based baseline;
  - more than 30% of known labels are uncertain.

## Share of voice (`/analytics/share-of-voice`)
```
SoV(e) = unique articles mentioning e  ÷  Σ_{e' in group} unique articles mentioning e'  × 100
```
- **Group.** You choose up to 10 entities (`entityIds`). Without a choice, the five most-mentioned entities in scope are used
  (locations and events excluded), and a warning says so.
- **Denominator.** The denominator sums the per-entity article counts, so shares add up to 100%. An article that names several
  entities in the group counts once for each of them. The number of such co-mentions is reported as `coMentionArticles`,
  and `eligibleArticles` is the number of distinct articles that mention at least one entity in the group.
- **Duplicate handling.** Only unique articles count.
- **Matching rule.** An article counts for an entity when its current analysis contains the entity after alias resolution.
  There is no fuzzy matching at query time.
- **Source coverage.** Only sources collected for the projects in scope are included. Coverage elsewhere is not represented.
- **No reach, audience, impression or advertising-value estimates** are used or implied.
- **Warnings** are given when:
  - the group mixes entity types (comparing unlike things);
  - fewer than 30 eligible articles;
  - co-mentions occur;
  - the group was auto-selected;
  - an entity filter is set (it is ignored for share of voice).

## Sources (`/analytics/sources`)
Each publisher row shows:
- unique articles and records, and its share of the unique articles in scope;
- **active days**: distinct local days with at least one record;
- articles per active day;
- first and last record;
- **median collection lag**: `discovered_at − published_at` in minutes, over dated records only;
- the number of undated records, the top 3 topics, and the tone counts with their shares.

**Diversity** is Simpson's index, `1 − Σ p²`, over publisher shares of unique articles: 0 means a single publisher, and the
closer to 1, the more evenly spread. The **top-5 share** is reported alongside it. Pagination uses `limit` (≤ 100) and `offset`.

**Publishing frequency is not a measure of credibility, accuracy or influence.** Collection lag reflects feed and polling
delays as well as publisher timing.

## Topics and entities
- **Topic articles** = unique analysed articles that carry the topic in their current analysis. An article can carry up to three
  topics, so topic counts do not add up to the total. `shareOfAnalysed` uses analysed articles as its denominator.
- **Emerging** = at least 3 articles in the period, and either new or up at least 50% on the previous period. This is
  descriptive, not a forecast.
- **Trends** give the timeline of the top 5 topics.
- **Entity articles** = unique analysed articles that mention the entity. Changes are computed against the previous period.
- **Co-occurrence** = unique articles that mention both entities: pairs among the top 10 entities, or pairs with the
  filtered entity. **Co-occurrence is not evidence of a relationship.**
- **Issue associations** = detected issues for the topic or entity that overlap the period, in the chosen issue status
  (the default is the open statuses).

## Issues (`/analytics/issues`)
An issue is *active during the period* if it was first detected before the period ends and last detected after the period starts.
Results are filtered by `issueStatus` (the default is the open statuses) and reported per severity. High-priority means high plus critical.

## Filters
Every endpoint accepts these filters:
- period: `from`, `to` (ISO 8601), or `days`;
- `projectId`, `entityId`, `topic`, `sourceId`, `language` (detected, otherwise the feed-declared language, otherwise `und`);
- `sentiment` (`positive|negative|neutral|mixed|unknown|unanalysed`) and `issueStatus`;
- `granularity`, `entityIds` (share-of-voice group), `limit` and `offset`;
- `channel`: `news` (**default**), `social` or `all`. Executive analytics and reports count news articles unless a caller asks for
  social records explicitly. Social analytics have their own endpoint and definitions (SOCIAL_CONNECTORS.md, section 6),
  because a post's or comment's tone and engagement are not comparable with a news article's coverage tone. The hourly
  aggregate holds news only; other channels are answered from base tables.

## Freshness, completeness and caching
Every response carries:
- `period`: from, to, timezone, granularity and the boundary rule;
- `freshness`, read **on every request** and never cached:
  - the latest project match and the latest analysis;
  - aggregate data version and refresh time;
  - enabled, healthy, unhealthy and stale sources, and the sources needing attention;
  - notes, for example "no collection source is enabled" or "the period ends near the present";
- `cache`: whether the response was served from the cache, when it was computed and when it expires;
- definitions of every metric.

**Aggregation.** `analytics_hourly` holds summable counts per tenant, project, hour, source, language, tone and uncertainty.
A worker job runs every 2 minutes (`ANALYTICS_REFRESH_INTERVAL_MS`) and recomputes only the hours touched by new records,
new analyses or new project matches, which it finds from three watermarks. A full rebuild once a day catches removed matches
and deletions. Distinct counts (publishers, entities) cannot be summed across hours, so they come from indexed base-table
queries and are cached. The timeline uses the aggregate only when all of these hold:
- one project is in scope;
- the filters are ones the aggregate stores;
- the period is hour-aligned and the time zone has a whole-hour offset;
- the aggregate is current.

Even then, its totals are checked against the base-table totals, and any mismatch falls back to the base tables.
The response says which source was used (`timeline.source`).

**Cache** (`analytics_cache`). The key is a hash of the metric, the normalised filters, the visible projects, the period, the
time zone and the granularity. An entry is used only when both hold:
- the tenant's `data_version` and the data stamp (newest match, record and analysis) are unchanged;
- it has not expired (15 minutes, `ANALYTICS_CACHE_TTL_SECONDS`).

New data therefore invalidates the cache immediately. A deleted record does not move the stamp, so a cached entry can still
include it until the entry expires (at most 15 minutes) or the next full rebuild, whichever comes first.

## Known limitations
- Tone and entity extraction come from the current analysis method. With the baseline method, tone labels are weak (see AI_EVALUATION.md)
  and are shown as uncertain.
- Coverage depends entirely on the configured sources. Gaps in collection reduce counts and are reported under freshness.
- Share of voice and the per-entity figures inherit the entity extraction's recall. Entities the analysis missed are not counted.
- No metric measures public opinion, programme effectiveness or communication outcomes, and none should be read that way.
