import type { Candidate } from './detection';
import { independentPublishers } from './detection';
import { SEVERITIES, severityRank, type Severity } from './levels';

/**
 * Transparent, points-based severity. Every factor, its value and the points it contributed are stored with the issue
 * (docs/ALERT_RULES.md has the same table). No model judgement enters the calculation.
 *
 *   factor                     value                                   points
 *   absolute volume            records in window ≥ 10 / 30 / 100        +1 / +2 / +3
 *   change vs baseline         ratio ≥ 2 / 4 / 8                        +1 / +2 / +3
 *   independent publishers     ≥ 3 / 6 / 12                             +1 / +2 / +3
 *   negative share             ≥ 40% / 60% (≥ 20 confident records)     +1 / +2
 *   topic relevance            subject is a project category/entity     +1
 *   evidence quality           > 50% headline-only or uncertain         −1
 *   data freshness             newest record > 24 h old, or collection stale   −1
 *   source reliability         no reliability metadata exists yet       0 (recorded as unavailable)
 *
 *   points → level: ≤ 1 informational · 2–3 low · 4–5 medium · 6–7 high · ≥ 8 critical
 *   caps: critical needs ≥ 3 independent publishers; single-publisher concentration is at most low;
 *         a rule's severity floor (e.g. critical keywords) raises the level, never lowers it.
 */
export interface SeverityContext {
  topicRelevant: boolean;
  collectionStale: boolean;
  now: number;
  floor: Severity | null;
}
export interface SeverityFactor { factor: string; value: string | number | null; points: number; rule: string }
export interface SeverityResult { severity: Severity; points: number; factors: SeverityFactor[]; caps: string[] }

const step = (v: number, cuts: number[]) => cuts.filter((c) => v >= c).length;

export function computeSeverity(c: Candidate, ctx: SeverityContext): SeverityResult {
  const ev = c.evidence;
  const factors: SeverityFactor[] = [];
  const add = (factor: string, value: SeverityFactor['value'], points: number, rule: string) => factors.push({ factor, value, points, rule });

  const volume = Number(c.result.observed.mentions ?? ev.length);
  add('absolute_volume', volume, step(volume, [10, 30, 100]), '≥10 +1, ≥30 +2, ≥100 +3');
  const ratio = c.result.observed.ratio;
  add('change_vs_baseline', ratio ?? null, ratio === undefined ? 0 : step(ratio, [2, 4, 8]), ratio === undefined ? 'not applicable to this signal' : 'ratio ≥2 +1, ≥4 +2, ≥8 +3');
  const ind = independentPublishers(ev);
  add('independent_publishers', ind, step(ind, [3, 6, 12]), '≥3 +1, ≥6 +2, ≥12 +3 (syndicated copies excluded)');
  const confident = ev.filter((r) => r.analysed && !r.uncertain && r.label && r.label !== 'unknown');
  const neg = confident.length >= 20 ? confident.filter((r) => r.label === 'negative').length / confident.length : null;
  add('negative_share', neg === null ? null : Math.round(neg * 100) / 100, neg === null ? 0 : step(neg, [0.4, 0.6]),
    neg === null ? 'fewer than 20 confident classifications: not scored' : '≥40% +1, ≥60% +2');
  add('topic_relevance', ctx.topicRelevant ? 'yes' : 'no', ctx.topicRelevant ? 1 : 0, 'subject is a project category or monitored entity +1');
  const weak = ev.length ? ev.filter((r) => r.headlineOnly || r.uncertain || !r.analysed).length / ev.length : 1;
  add('evidence_quality', Math.round(weak * 100) / 100, weak > 0.5 ? -1 : 0, '>50% headline-only, unanalysed or uncertain −1');
  const newest = ev.length ? Math.max(...ev.map((r) => r.t)) : 0;
  const stale = ctx.collectionStale || (newest > 0 && ctx.now - newest > 24 * 3_600_000);
  add('data_freshness', ctx.collectionStale ? 'collection stale' : newest ? `${Math.round((ctx.now - newest) / 3_600_000)} h since newest record` : 'no records',
    stale ? -1 : 0, 'newest record >24 h old or collection stale −1');
  add('source_reliability', null, 0, 'no source reliability metadata is recorded yet; not scored');

  const points = factors.reduce((n, f) => n + f.points, 0);
  let level: Severity = points <= 1 ? 'informational' : points <= 3 ? 'low' : points <= 5 ? 'medium' : points <= 7 ? 'high' : 'critical';
  const caps: string[] = [];
  if (level === 'critical' && ind < 3) { level = 'high'; caps.push('critical requires ≥3 independent publishers → high'); }
  if (c.signal === 'source_concentration' && severityRank(level) > severityRank('low')) { level = 'low'; caps.push('single-publisher concentration capped at low'); }
  if (ctx.floor && severityRank(level) < severityRank(ctx.floor)) { caps.push(`rule floor raises ${level} → ${ctx.floor}`); level = ctx.floor; }
  return { severity: level, points, factors, caps };
}

export const maxSeverity = (a: Severity, b: Severity): Severity => SEVERITIES[Math.max(severityRank(a), severityRank(b))]!;
