# Alert rules and issue detection

An **alert rule** watches one project's collected coverage. When the rule's thresholds are exceeded, the system creates an
**issue**: a persisted record of what was detected, why, how severe it is, and which source records support it. People then
acknowledge, investigate and resolve the issue. Code: `apps/api/src/alerts/` (pure maths in `detection.ts` and `severity.ts`).

Detection is automated and works on collected coverage only. It does not establish facts, and it does not score, profile or
assess individual citizens. Rules monitor institutions, topics, programmes, keywords and stories in public coverage.

## What gets compared
- **Population:** original (non-duplicate) records matched to the rule's project. Optional filters narrow it to entities
  (institutions, programmes …), sources, topics, or a keyword expression in the monitoring-query syntax. Expressions are
  parsed with the same bounded parser; they are never turned into SQL or code.
- **Time:** each record's publication time, or its discovery time when the publisher gives none.
- **Window:** the last *N* minutes (15 minutes – 7 days).
- **Comparable windows:** either the same time of day on previous days (accounts for the daily news rhythm; windows ≤ 24 h)
  or the immediately preceding windows of the same length.
- **Historical gaps:** a comparison window counts only if collection actually succeeded in it (or within 2 h after it).
  Windows without collection are excluded, not treated as zero coverage. The issue lists how many were excluded.

## Signals
| Signal (`rule_type`) | Method | Triggers when | Suppressed when |
|---|---|---|---|
| `volume_spike` | robust z-score: (observed − median) / (1.4826 × MAD); ratio = observed / max(median, 1) | records ≥ `minMentions` **and** ratio ≥ `relativeChange` **and** z ≥ `robustZ` (and publishers ≥ `minPublishers`) | fewer than `minBaselineWindows` covered comparison windows; count below minimum |
| `negative_shift` | share of negative among *confident* classifications, current vs pooled comparison windows; two-proportion z statistic | shift ≥ `negativeShift` **and** z ≥ `zThreshold` | uncertain share > `maxUncertainShare` in either period; fewer than `minClassified` confident classifications in either; too few covered windows |
| `emerging_topic` | volume spike per topic | as volume spike, plus baseline median ≤ `uncommonMaxPerWindow` and ≥ `minPublishers` independent publishers | as volume spike |
| `keyword` | expression match within the window | matches ≥ `minMentions` | count below minimum |
| `story_velocity` | records of one story cluster within the window | records ≥ `minMentions` **and** independent publishers ≥ `minIndependentPublishers` | (none) |
| `source_concentration` | share of the window's records from one publisher | records ≥ `minMentions` **and** share ≥ `concentrationShare` | (none) |

When at least half of the comparison windows are identical (MAD = 0, common with sparse coverage), the scale falls back to
√max(median, 1). That way a single extra article over an all-zero baseline does not alert, and the issue records that this
happened.

**No significance claims.** The robust z-score and the two-proportion z statistic describe how unusual a value is. News records
are not independent samples (follow-ups, shared wire copy), so no p-value is reported and nothing is called "statistically
significant".

**Scope.** Every issue is labelled as one of three scopes:
- **Single article:** one record.
- **Related-story cluster:** all records in one automatically grouped story.
- **Broader issue:** records across stories.

**Independence.** "Independent publishers" counts distinct publishers among records that are not syndicated copies.
Repeated wire text is never counted as confirmation.

**Regional detection** is not implemented. Location entities come from text extraction, not reliable geographic metadata,
so they cannot support regional anomaly claims. Use an entity filter on a location to *monitor* a region without claiming
regional statistics.

## Severity (transparent points)
| Factor | Points |
|---|---|
| Absolute volume: records in window ≥ 10 / 30 / 100 | +1 / +2 / +3 |
| Change vs baseline: ratio ≥ 2 / 4 / 8 | +1 / +2 / +3 |
| Independent publishers ≥ 3 / 6 / 12 | +1 / +2 / +3 |
| Negative share ≥ 40% / 60% (only with ≥ 20 confident classifications) | +1 / +2 |
| Topic relevance: rule filters on monitored entities or a project category | +1 |
| Evidence quality: > 50% of records headline-only, unanalysed or uncertain | −1 |
| Data freshness: newest record > 24 h old, or no successful collection for `ALERTS_COLLECTION_STALE_HOURS` | −1 |
| Source reliability | 0: no reliability metadata exists yet (recorded as "not scored") |

**Points to level:** ≤ 1 informational · 2–3 low · 4–5 medium · 6–7 high · ≥ 8 critical.

**Caps and floors:**
- Critical requires ≥ 3 independent publishers; otherwise the issue is capped at high.
- Single-publisher concentration is capped at low.
- A rule's `severity.floor` raises the level and never lowers it. Use it for critical keywords.
- A rule's `severity.minimum` drops detections below it; they are recorded in the evaluation ledger as `below_severity_minimum`.

Every factor, its value, its points and every adjustment are stored with the issue and shown on the issue page.
An AI model never decides severity. An AI summary, when available, is shown separately and labelled.

## Configuration reference
```jsonc
{
  "filters":   { "entityIds": [], "sourceIds": [], "topics": [], "keywords": "karhutla OR \"kabut asap\"",
                 "channels": ["news"] },   // default news only; ["news","social"] or ["social"] includes social-platform records
  "window":    { "minutes": 60, "comparison": "same_time_previous_days", "baselineWindows": 14 },
  "thresholds": { "minMentions": 5, "relativeChange": 2, "robustZ": 3, "minBaselineWindows": 5, "minPublishers": 1,
                  "negativeShift": 0.15, "minClassified": 20, "maxUncertainShare": 0.5, "zThreshold": 1.96,
                  "uncommonMaxPerWindow": 1, "minIndependentPublishers": 3, "concentrationShare": 0.6 },
  "severity":  { "minimum": "low", "floor": null },
  "notify":    { "channels": ["in_app", "email"], "recipientUserIds": [], "webhookEndpointIds": [] },
  "cooldownMinutes": 120,
  "quietHours": { "start": "22:00", "end": "06:00", "timezone": "Asia/Jakarta", "allowCritical": true },
  "escalation": { "steps": [{ "afterMinutes": 30, "notifyUserIds": ["…"] }] }
}
```
- **Validation:** the server validates the configuration (`rule-config.ts`) on every write. Unknown keys are rejected; numbers are bounded; look-back is at most 90 days.
- **References:** referenced entities, sources, project categories and webhooks must belong to the organization. Recipients must be members who can see the project's issues.
- **Defaults:** missing fields get defaults, and the stored version contains the fully expanded configuration.

## Versioning
Every configuration edit creates an immutable `alert_rule_versions` row. The application role cannot update or delete
versions. Each issue stores the version that created it (and the latest version that updated it), and the issue page shows
that version's configuration.

Renaming a rule, changing its owner, or enabling/disabling it does not create a version. Deleting a rule is a soft delete:
it stops evaluating, and its versions and issues remain.

## Lifecycle
`Detected → Pending review → Acknowledged → Investigating → Resolved → Closed`.

| Change | Who / what | Notes |
|---|---|---|
| Detected → Pending review | system | When notifications are planned |
| Acknowledge, assign, start investigation, resolve (with reason), reopen (with reason), notes | users with `alerts:acknowledge` | owner, admin, project manager, analyst |
| Close | users with `alerts:manage` | |
| Resolved → Pending review | system | Automatic reopen when new supporting records arrive |

- **Reopening a closed issue:** allowed manually, unless a newer issue for the same rule and subject is already open (409).
- **Assignees:** must be members who can see the project's issues.
- **History:** every change is an append-only `alert_events` row and an audit event. The audit log records that a note was
  added, not its text.

## Deduplication, cooldown, escalation
- **One open issue per rule and subject.** Subjects are the project, an entity, a topic, a keyword expression, a story
  cluster or a publisher. Re-detection adds evidence to the same issue (`occurrence_count`) instead of creating a duplicate.
  Evidence is unique per (issue, record).
- **Evaluations are idempotent.** There is one ledger row per tenant and time bucket. A per-tenant transaction lock
  serialises concurrent evaluations. Repeated processing of the same records changes nothing and sends nothing.
- **Related issues:** issues from different rules about the same subject share a `group_key` and are listed as related.
- **Cooldown:** within `cooldownMinutes` of the last notification about an issue, re-detection or automatic reopening does not
  notify again. This also applies to a new issue that follows a closed one with the same rule and subject. A severity
  increase always notifies, once per new level.
- **Escalation:** issues still unacknowledged after each step's `afterMinutes` notify that step's users, once per level.
  Acknowledging stops further escalation.

## Testing a rule
- **Dry run on saved rules:** `POST /organizations/:org/alert-rules/:id/test` runs the rule on current data and returns what it
  would detect, with methods, values and limitations. It creates nothing and sends nothing.
- **Preview of unsaved rules:** `POST …/alert-rules/preview` does the same for an unsaved configuration.
- **Rate limit:** both share a limit of 10 per minute per organization, and both are audited.

## Social records in detection
Rules evaluate **news articles only** unless `filters.channels` includes `"social"`. The baseline comes from the same filtered
population, so a rule that opts in compares social volume with social history, never with news. Social volume is attention among
collected posts, not public opinion: prefer `minPublishers`/independent-source thresholds and review evidence before escalating.
Records whose provider forbids derived analysis (YouTube without the recorded approval) have no tone, so tone rules ignore them.
