import { createHash } from 'node:crypto';
import type { RuleConfig, RuleType } from './rule-config';

/**
 * Pure detection functions. Inputs are plain arrays (no database, no clock), so every calculation is unit-testable.
 * Statistical language is deliberate: robust z-scores and the two-proportion z statistic are descriptive measures of how
 * unusual a value is. Coverage records are not independent samples, so no p-value is reported as significance.
 */

export interface Row {
  id: string;
  t: number;                    // ms epoch: publication time, else discovery time
  publisher: string;
  sourceId: string;
  clusterId: string | null;
  syndicated: boolean;          // identical copy of another publisher's text
  analysed: boolean;
  label: 'positive' | 'negative' | 'neutral' | 'mixed' | 'unknown' | null;
  uncertain: boolean;
  topics: string[];
  headlineOnly: boolean;
}

export interface Window { from: number; to: number; covered: boolean }
export interface Windows { current: Window; baseline: Window[] }

export interface DetectionResult {
  triggered: boolean;
  suppressed: null | { reason: 'insufficient_baseline' | 'below_minimum_count' | 'insufficient_sample' | 'classification_uncertain' | 'current_window_not_covered'; detail: string };
  method: string;
  observed: Record<string, number>;
  baseline: Record<string, number | null>;
  thresholds: Record<string, number>;
  exceeded: string[];
  limitations: string[];
}

export interface Candidate {
  signal: RuleType;
  scope: 'article' | 'story' | 'issue';
  subjectType: 'project' | 'topic' | 'entity' | 'keyword' | 'cluster' | 'publisher';
  subjectKey: string;
  title: string;
  evidence: Row[];
  result: DetectionResult;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// ── Basic statistics ─────────────────────────────────────────────────────────────────────────────────
export function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
export function stdev(xs: number[]): number {
  if (xs.length < 2) return NaN;
  const m = mean(xs); return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}
/** Median absolute deviation (unscaled). */
export const mad = (xs: number[]) => median(xs.map((x) => Math.abs(x - median(xs))));
const r3 = (n: number) => (Number.isFinite(n) ? Math.round(n * 1000) / 1000 : n);

// ── Windows ──────────────────────────────────────────────────────────────────────────────────────────
/**
 * Current window ends at `now`. Comparable windows are either the same time of day on previous days (accounts for
 * daily news rhythm) or the immediately preceding windows of the same length. `isCovered` says whether collection
 * actually ran in a window; uncovered windows are historical gaps, excluded instead of counted as zero.
 */
export function buildWindows(now: number, cfg: RuleConfig['window'], isCovered: (from: number, to: number) => boolean): Windows {
  const len = cfg.minutes * 60_000;
  const current = { from: now - len, to: now, covered: isCovered(now - len, now) };
  const baseline: Window[] = [];
  for (let k = 1; k <= cfg.baselineWindows; k++) {
    const end = cfg.comparison === 'same_time_previous_days' ? now - k * DAY : now - k * len;
    baseline.push({ from: end - len, to: end, covered: isCovered(end - len, end) });
  }
  return { current, baseline };
}
export const inWindow = (r: Row, w: Window) => r.t > w.from && r.t <= w.to;
export const publishers = (rows: Row[]) => new Set(rows.map((r) => r.publisher)).size;
/** Distinct publishers among records that are not syndicated copies: repeated wire text is not independent confirmation. */
export const independentPublishers = (rows: Row[]) => new Set(rows.filter((r) => !r.syndicated).map((r) => r.publisher)).size;

// ── Volume spike ─────────────────────────────────────────────────────────────────────────────────────
export function volumeSpike(observed: number, history: number[], th: RuleConfig['thresholds']): DetectionResult {
  const method = 'robust-z/median-MAD';
  const thresholds = { minMentions: th.minMentions, relativeChange: th.relativeChange, robustZ: th.robustZ, minBaselineWindows: th.minBaselineWindows };
  const base = { windows: history.length, median: history.length ? r3(median(history)) : null, mean: history.length ? r3(mean(history)) : null,
    stdev: history.length > 1 ? r3(stdev(history)) : null, mad: history.length ? r3(mad(history)) : null };
  const limitations: string[] = [];
  if (history.length < th.minBaselineWindows) {
    return { triggered: false, suppressed: { reason: 'insufficient_baseline', detail: `${history.length} covered comparison windows; ${th.minBaselineWindows} required` },
      method, observed: { mentions: observed }, baseline: base, thresholds, exceeded: [], limitations };
  }
  const m = median(history);
  const madv = mad(history);
  // MAD scaled to be comparable with a standard deviation. When at least half the windows are identical (MAD = 0, common
  // for sparse coverage), fall back to a Poisson-like scale sqrt(max(median, 1)) so a single extra article cannot alert.
  const scale = madv > 0 ? 1.4826 * madv : Math.sqrt(Math.max(m, 1));
  if (madv === 0) limitations.push('Baseline has little variation (MAD = 0); a Poisson-like scale was used.');
  const z = (observed - m) / scale;
  const ratio = observed / Math.max(m, 1);
  const exceeded: string[] = [];
  if (observed >= th.minMentions) exceeded.push('minMentions');
  if (ratio >= th.relativeChange) exceeded.push('relativeChange');
  if (z >= th.robustZ) exceeded.push('robustZ');
  const triggered = exceeded.length === 3;
  return {
    triggered,
    suppressed: observed < th.minMentions ? { reason: 'below_minimum_count', detail: `${observed} < ${th.minMentions}` } : null,
    method, observed: { mentions: observed, ratio: r3(ratio), robustZ: r3(z) }, baseline: base, thresholds, exceeded, limitations,
  };
}

// ── Sentiment shift ──────────────────────────────────────────────────────────────────────────────────
export interface SentimentStats { total: number; analysed: number; uncertain: number; confident: number; negative: number }
export function sentimentStats(rows: Row[]): SentimentStats {
  const analysed = rows.filter((r) => r.analysed && r.label);
  const confident = analysed.filter((r) => !r.uncertain && r.label !== 'unknown');
  return { total: rows.length, analysed: analysed.length, uncertain: analysed.length - confident.length, confident: confident.length,
    negative: confident.filter((r) => r.label === 'negative').length };
}

/**
 * Compares the share of negative records among confident classifications. Uncertain classifications are excluded from
 * the proportions and reported separately; if they dominate either window the result is suppressed, because a change
 * would then reflect the classifier rather than coverage.
 */
export function negativeShift(cur: SentimentStats, base: SentimentStats, th: RuleConfig['thresholds']): DetectionResult {
  const method = 'two-proportion comparison (negative share among confident classifications)';
  const thresholds = { negativeShift: th.negativeShift, minClassified: th.minClassified, maxUncertainShare: th.maxUncertainShare, zThreshold: th.zThreshold };
  const p1 = cur.confident ? cur.negative / cur.confident : NaN;
  const p0 = base.confident ? base.negative / base.confident : NaN;
  const u1 = cur.analysed ? cur.uncertain / cur.analysed : 1;
  const u0 = base.analysed ? base.uncertain / base.analysed : 1;
  const observed = { negativeShare: r3(p1), confident: cur.confident, uncertainShare: r3(u1), records: cur.total };
  const baseline = { negativeShare: Number.isFinite(p0) ? r3(p0) : null, confident: base.confident, uncertainShare: r3(u0), records: base.total };
  const limitations = ['Records are not independent samples (shared sources, follow-ups); the z statistic is descriptive, not a significance test.'];
  const out = (s: DetectionResult['suppressed']): DetectionResult => ({ triggered: false, suppressed: s, method, observed, baseline, thresholds, exceeded: [], limitations });
  if (u1 > th.maxUncertainShare || u0 > th.maxUncertainShare) {
    return out({ reason: 'classification_uncertain', detail: `uncertain share ${Math.round(u1 * 100)}% now, ${Math.round(u0 * 100)}% baseline (max ${Math.round(th.maxUncertainShare * 100)}%)` });
  }
  if (cur.confident < th.minClassified || base.confident < th.minClassified) {
    return out({ reason: 'insufficient_sample', detail: `${cur.confident} / ${base.confident} confident classifications; ${th.minClassified} required in each` });
  }
  const pooled = (cur.negative + base.negative) / (cur.confident + base.confident);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / cur.confident + 1 / base.confident));
  const z = se > 0 ? (p1 - p0) / se : 0;
  const exceeded: string[] = [];
  if (p1 - p0 >= th.negativeShift) exceeded.push('negativeShift');
  if (z >= th.zThreshold) exceeded.push('zThreshold');
  return { triggered: exceeded.length === 2, suppressed: null, method, observed: { ...observed, shift: r3(p1 - p0), z: r3(z) }, baseline, thresholds, exceeded, limitations };
}

// ── Candidates per rule type ─────────────────────────────────────────────────────────────────────────
export interface DetectInput {
  type: RuleType;
  config: RuleConfig;
  rows: Row[];                              // filtered population for the whole look-back
  windows: Windows;
  projectId: string;
  /** Subject when the filters narrow to one entity or topic; otherwise the project. */
  subject: { type: Candidate['subjectType']; key: string; label: string };
  topicLabel: (key: string) => string;
}

const coveredBaseline = (w: Windows) => w.baseline.filter((b) => b.covered);
const notCovered = (method: string): DetectionResult => ({ triggered: false, suppressed: { reason: 'current_window_not_covered', detail: 'No successful collection run in the current window' },
  method, observed: {}, baseline: {}, thresholds: {}, exceeded: [], limitations: [] });

export function detect(input: DetectInput): Candidate[] {
  const { type, config, rows, windows, subject } = input;
  const th = config.thresholds;
  const cur = rows.filter((r) => inWindow(r, windows.current));
  const base = coveredBaseline(windows);
  const span = `${config.window.minutes} min`;
  if (!windows.current.covered && type !== 'keyword') {
    return [{ signal: type, scope: 'issue', subjectType: subject.type, subjectKey: subject.key, title: '', evidence: [], result: notCovered(type) }];
  }
  switch (type) {
    case 'volume_spike': {
      const history = base.map((w) => rows.filter((r) => inWindow(r, w)).length);
      const result = volumeSpike(cur.length, history, th);
      if (publishers(cur) < th.minPublishers && result.triggered) {
        result.triggered = false; result.suppressed = { reason: 'below_minimum_count', detail: `${publishers(cur)} publishers < ${th.minPublishers}` };
      }
      result.observed.publishers = publishers(cur); result.observed.independentPublishers = independentPublishers(cur);
      return [{ signal: type, scope: 'issue', subjectType: subject.type, subjectKey: subject.key, evidence: cur, result,
        title: `Coverage volume spike: ${subject.label} (${cur.length} records in ${span}, baseline median ${result.baseline.median ?? '—'})` }];
    }
    case 'negative_shift': {
      const baseRows = rows.filter((r) => base.some((w) => inWindow(r, w)));
      const result = negativeShift(sentimentStats(cur), sentimentStats(baseRows), th);
      if (base.length < th.minBaselineWindows && !result.suppressed) {
        result.triggered = false; result.suppressed = { reason: 'insufficient_baseline', detail: `${base.length} covered comparison windows; ${th.minBaselineWindows} required` };
      }
      return [{ signal: type, scope: 'issue', subjectType: subject.type, subjectKey: subject.key, evidence: cur.filter((r) => r.label === 'negative' && !r.uncertain), result,
        title: `Negative-tone shift: ${subject.label} (${Math.round((result.observed.negativeShare ?? 0) * 100)}% negative vs ${result.baseline.negativeShare === null ? '—' : Math.round(Number(result.baseline.negativeShare) * 100) + '%'} baseline)` }];
    }
    case 'emerging_topic': {
      const topics = new Set(cur.flatMap((r) => r.topics).filter((t) => t !== 'unknown' && t !== 'other' && (config.filters.topics.length === 0 || config.filters.topics.includes(t))));
      const out: Candidate[] = [];
      for (const topic of topics) {
        const tr = cur.filter((r) => r.topics.includes(topic));
        const history = base.map((w) => rows.filter((r) => inWindow(r, w) && r.topics.includes(topic)).length);
        const result = volumeSpike(tr.length, history, th);
        result.method = 'robust-z/median-MAD per topic, previously uncommon';
        const m = history.length ? median(history) : NaN;
        const pubs = independentPublishers(tr);
        result.observed.independentPublishers = pubs;
        result.baseline.uncommonMaxPerWindow = th.uncommonMaxPerWindow;
        if (result.triggered && !(m <= th.uncommonMaxPerWindow)) { result.triggered = false; result.suppressed = { reason: 'below_minimum_count', detail: `Topic not previously uncommon (baseline median ${m})` }; }
        if (result.triggered && pubs < th.minPublishers) { result.triggered = false; result.suppressed = { reason: 'below_minimum_count', detail: `${pubs} independent publishers < ${th.minPublishers}` }; }
        else if (pubs >= th.minPublishers) result.exceeded.push('minPublishers');
        out.push({ signal: type, scope: 'issue', subjectType: 'topic', subjectKey: topic, evidence: tr, result,
          title: `Emerging topic: ${input.topicLabel(topic)} (${tr.length} records from ${pubs} publishers in ${span})` });
      }
      return out;
    }
    case 'keyword': {
      const result: DetectionResult = { triggered: cur.length >= th.minMentions, suppressed: cur.length >= th.minMentions ? null : { reason: 'below_minimum_count', detail: `${cur.length} < ${th.minMentions}` },
        method: 'keyword expression match in window', observed: { mentions: cur.length, publishers: publishers(cur), independentPublishers: independentPublishers(cur) },
        baseline: {}, thresholds: { minMentions: th.minMentions }, exceeded: cur.length >= th.minMentions ? ['minMentions'] : [], limitations: [] };
      if (!windows.current.covered) result.limitations.push('No successful collection run in the current window; matches may be incomplete.');
      const clusters = new Set(cur.map((r) => r.clusterId));
      const scope = cur.length === 1 ? 'article' : clusters.size === 1 && !clusters.has(null) ? 'story' : 'issue';
      const key = createHash('sha256').update(config.filters.keywords ?? '').digest('hex').slice(0, 16);
      return [{ signal: type, scope, subjectType: 'keyword', subjectKey: key, evidence: cur, result,
        title: `Critical keyword: “${(config.filters.keywords ?? '').slice(0, 80)}” (${cur.length} record${cur.length === 1 ? '' : 's'} in ${span})` }];
    }
    case 'story_velocity': {
      const byCluster = new Map<string, Row[]>();
      for (const r of cur) if (r.clusterId) byCluster.set(r.clusterId, [...(byCluster.get(r.clusterId) ?? []), r]);
      const out: Candidate[] = [];
      for (const [cid, rs] of byCluster) {
        const ind = independentPublishers(rs);
        const exceeded = [rs.length >= th.minMentions ? 'minMentions' : '', ind >= th.minIndependentPublishers ? 'minIndependentPublishers' : ''].filter(Boolean);
        const result: DetectionResult = { triggered: exceeded.length === 2, suppressed: null, method: 'story growth within window (independent publishers)',
          observed: { mentions: rs.length, independentPublishers: ind, syndicatedCopies: rs.filter((r) => r.syndicated).length }, baseline: {},
          thresholds: { minMentions: th.minMentions, minIndependentPublishers: th.minIndependentPublishers }, exceeded,
          limitations: ['Story grouping is automatic (headline/entity/topic similarity) and may merge or split events.'] };
        out.push({ signal: type, scope: 'story', subjectType: 'cluster', subjectKey: cid, evidence: rs, result,
          title: `Fast-developing story (${rs.length} records, ${ind} independent publishers in ${span})` });
      }
      return out;
    }
    case 'source_concentration': {
      const byPub = new Map<string, Row[]>();
      for (const r of cur) byPub.set(r.publisher, [...(byPub.get(r.publisher) ?? []), r]);
      const out: Candidate[] = [];
      for (const [pub, rs] of byPub) {
        const share = cur.length ? rs.length / cur.length : 0;
        const exceeded = [rs.length >= th.minMentions ? 'minMentions' : '', share >= th.concentrationShare ? 'concentrationShare' : ''].filter(Boolean);
        out.push({ signal: type, scope: 'issue', subjectType: 'publisher', subjectKey: pub, evidence: rs,
          result: { triggered: exceeded.length === 2, suppressed: null, method: 'single-publisher share of window coverage',
            observed: { mentions: rs.length, share: r3(share), windowTotal: cur.length }, baseline: {}, thresholds: { minMentions: th.minMentions, concentrationShare: th.concentrationShare },
            exceeded, limitations: ['Concentrated coverage from one publisher is repeated, not independently confirmed, reporting.'] },
          title: `Coverage concentrated in one publisher: ${pub} (${Math.round(share * 100)}% of ${cur.length} records in ${span})` });
      }
      return out;
    }
  }
}
