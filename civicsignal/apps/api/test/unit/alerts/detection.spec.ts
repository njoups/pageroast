import { buildWindows, detect, independentPublishers, mad, median, negativeShift, sentimentStats, volumeSpike, type Row, type Windows } from '../../../src/alerts/detection';
import { validateRuleConfig, type RuleConfig } from '../../../src/alerts/rule-config';
import { computeSeverity } from '../../../src/alerts/severity';

const H = 3_600_000; const D = 24 * H;
const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);
const th = (o: Partial<RuleConfig['thresholds']> = {}) => ({ ...validateRuleConfig('volume_spike', {}).thresholds, ...o });
let n = 0;
const row = (t: number, o: Partial<Row> = {}): Row => ({ id: `m${++n}`, t, publisher: `p${n % 5}.example`, sourceId: 's1', clusterId: null, syndicated: false, analysed: true,
  label: 'neutral', uncertain: false, topics: ['economy'], headlineOnly: false, ...o });
const allCovered = () => true;

describe('statistics', () => {
  it('median and MAD', () => {
    expect(median([5, 1, 3])).toBe(3); expect(median([1, 2, 3, 4])).toBe(2.5); expect(Number.isNaN(median([]))).toBe(true);
    expect(mad([1, 1, 2, 2, 4, 6, 9])).toBe(1);
  });
});

describe('volume spike', () => {
  it('triggers when count, ratio and robust z all exceed thresholds', () => {
    const r = volumeSpike(30, [4, 5, 6, 5, 4, 6, 5], th());
    expect(r).toMatchObject({ triggered: true, suppressed: null, method: 'robust-z/median-MAD' });
    expect(r.exceeded).toEqual(['minMentions', 'relativeChange', 'robustZ']);
    expect(r.baseline).toMatchObject({ median: 5, windows: 7 });
    expect(r.observed.ratio).toBe(6);
  });
  it('suppresses when the baseline has too few covered windows (no alert on an unreliable baseline)', () => {
    const r = volumeSpike(100, [1, 2], th({ minBaselineWindows: 5 }));
    expect(r).toMatchObject({ triggered: false, suppressed: { reason: 'insufficient_baseline' } });
  });
  it('low absolute counts never alert, even with a large relative change', () => {
    const r = volumeSpike(3, [0, 0, 0, 0, 0, 0], th({ minMentions: 5 }));
    expect(r).toMatchObject({ triggered: false, suppressed: { reason: 'below_minimum_count' } });
  });
  it('a flat zero baseline uses a Poisson-like scale, so one extra article is not a spike', () => {
    const r = volumeSpike(1, [0, 0, 0, 0, 0, 0], th({ minMentions: 1 }));
    expect(r.triggered).toBe(false);
    expect(r.limitations.join(' ')).toMatch(/MAD = 0/);
  });
  it('normal variation does not trigger', () => {
    expect(volumeSpike(9, [6, 8, 7, 9, 5, 8, 7], th()).triggered).toBe(false);
  });
});

describe('negative-tone shift', () => {
  const stats = (neg: number, confident: number, uncertain = 0) => ({ total: confident + uncertain, analysed: confident + uncertain, uncertain, confident, negative: neg });
  it('compares proportions, not counts, and reports the z statistic as descriptive', () => {
    const r = negativeShift(stats(30, 50), stats(40, 200), th());
    expect(r.triggered).toBe(true);
    expect(r.observed).toMatchObject({ negativeShare: 0.6, shift: 0.4 });
    expect(r.limitations.join(' ')).toMatch(/not a significance test/);
    // Same raw count of negatives but more coverage overall: no proportional change, no alert.
    expect(negativeShift(stats(40, 200), stats(40, 200), th()).triggered).toBe(false);
  });
  it('suppresses small samples', () => {
    expect(negativeShift(stats(8, 10), stats(5, 100), th())).toMatchObject({ triggered: false, suppressed: { reason: 'insufficient_sample' } });
  });
  it('suppresses when uncertain classifications dominate (model uncertainty is not a change in coverage)', () => {
    expect(negativeShift(stats(25, 30, 70), stats(10, 100), th())).toMatchObject({ triggered: false, suppressed: { reason: 'classification_uncertain' } });
  });
  it('sentimentStats excludes uncertain and unanalysed records from proportions', () => {
    const s = sentimentStats([row(NOW, { label: 'negative' }), row(NOW, { label: 'negative', uncertain: true }), row(NOW, { analysed: false, label: null })]);
    expect(s).toEqual({ total: 3, analysed: 2, uncertain: 1, confident: 1, negative: 1 });
  });
});

describe('windows and historical gaps', () => {
  it('same-time-of-day comparison windows, and uncovered windows are marked (excluded rather than counted as zero)', () => {
    const w = buildWindows(NOW, { minutes: 60, comparison: 'same_time_previous_days', baselineWindows: 3 }, (from) => from !== NOW - 2 * D - H);
    expect(w.current).toEqual({ from: NOW - H, to: NOW, covered: true });
    expect(w.baseline.map((b) => [b.to, b.covered])).toEqual([[NOW - D, true], [NOW - 2 * D, false], [NOW - 3 * D, true]]);
  });
  it('a spike over a baseline full of collection gaps is suppressed as insufficient baseline', () => {
    const cfg = validateRuleConfig('volume_spike', { window: { minutes: 60, baselineWindows: 7 }, thresholds: { minBaselineWindows: 5 } });
    const windows = buildWindows(NOW, cfg.window, (from) => from >= NOW - 2 * D - H);   // only the last 2 days were collected
    const rows = Array.from({ length: 20 }, () => row(NOW - 10 * 60_000));
    const [c] = detect({ type: 'volume_spike', config: cfg, rows, windows, projectId: 'p', subject: { type: 'project', key: 'p', label: 'P' }, topicLabel: (k) => k });
    expect(c!.result).toMatchObject({ triggered: false, suppressed: { reason: 'insufficient_baseline' } });
  });
});

describe('rule types', () => {
  const windows: Windows = buildWindows(NOW, { minutes: 1440, comparison: 'previous_windows', baselineWindows: 7 }, allCovered);
  const base = { projectId: 'p', subject: { type: 'project' as const, key: 'p', label: 'P' }, topicLabel: (k: string) => k };
  it('emerging topic: previously uncommon topic across several independent publishers', () => {
    const cfg = validateRuleConfig('emerging_topic', { window: { minutes: 1440, comparison: 'previous_windows', baselineWindows: 7 }, thresholds: { minMentions: 5, minPublishers: 3 } });
    const rows = [...Array.from({ length: 8 }, (_, i) => row(NOW - H, { topics: ['health'], publisher: `pub${i % 4}.example` })),
      ...Array.from({ length: 7 }, (_, k) => row(NOW - (k + 1) * D - H, { topics: ['economy'] }))];
    const out = detect({ ...base, type: 'emerging_topic', config: cfg, rows, windows });
    const health = out.find((c) => c.subjectKey === 'health')!;
    expect(health.result.triggered).toBe(true);
    expect(health.result.observed.independentPublishers).toBe(4);
    expect(out.find((c) => c.subjectKey === 'economy')).toBeUndefined();   // not in the current window
  });
  it('story velocity counts independent publishers; syndicated copies do not count as confirmation', () => {
    const cfg = validateRuleConfig('story_velocity', { window: { minutes: 1440, comparison: 'previous_windows' }, thresholds: { minMentions: 3, minIndependentPublishers: 3 } });
    const rows = [row(NOW - H, { clusterId: 'c1', publisher: 'a.example' }), row(NOW - H, { clusterId: 'c1', publisher: 'b.example', syndicated: true }),
      row(NOW - H, { clusterId: 'c1', publisher: 'c.example', syndicated: true }), row(NOW - H, { clusterId: 'c1', publisher: 'a.example' })];
    const [c] = detect({ ...base, type: 'story_velocity', config: cfg, rows, windows });
    expect(c!.scope).toBe('story');
    expect(c!.result).toMatchObject({ triggered: false, observed: { mentions: 4, independentPublishers: 1, syndicatedCopies: 2 } });
    expect(independentPublishers(rows)).toBe(1);
  });
  it('keyword rule: scope is article for one record, story when all in one cluster, issue otherwise', () => {
    const cfg = validateRuleConfig('keyword', { filters: { keywords: 'banjir' }, thresholds: { minMentions: 1 }, window: { minutes: 1440, comparison: 'previous_windows' } });
    expect(detect({ ...base, type: 'keyword', config: cfg, rows: [row(NOW - H)], windows })[0]!.scope).toBe('article');
    expect(detect({ ...base, type: 'keyword', config: cfg, rows: [row(NOW - H, { clusterId: 'x' }), row(NOW - H, { clusterId: 'x' })], windows })[0]!.scope).toBe('story');
    expect(detect({ ...base, type: 'keyword', config: cfg, rows: [row(NOW - H, { clusterId: 'x' }), row(NOW - H)], windows })[0]!.scope).toBe('issue');
  });
  it('source concentration is detected and capped at low severity', () => {
    const cfg = validateRuleConfig('source_concentration', { window: { minutes: 1440, comparison: 'previous_windows' }, thresholds: { minMentions: 5, concentrationShare: 0.6 } });
    const rows = [...Array.from({ length: 120 }, () => row(NOW - H, { publisher: 'one.example' })), row(NOW - H, { publisher: 'two.example' })];
    const c = detect({ ...base, type: 'source_concentration', config: cfg, rows, windows }).find((x) => x.subjectKey === 'one.example')!;
    expect(c.result.triggered).toBe(true);
    const s = computeSeverity(c, { topicRelevant: true, collectionStale: false, now: NOW, floor: null });
    expect(s.severity).toBe('low');
    expect(s.caps.join(' ')).toMatch(/capped at low/);
  });
  it('non-keyword rules are suppressed when the current window had no collection', () => {
    const w = buildWindows(NOW, { minutes: 60, comparison: 'previous_windows', baselineWindows: 5 }, () => false);
    const [c] = detect({ ...base, type: 'volume_spike', config: validateRuleConfig('volume_spike', {}), rows: [], windows: w });
    expect(c!.result.suppressed?.reason).toBe('current_window_not_covered');
  });
});

describe('severity', () => {
  const cand = (evidence: Row[], observed: Record<string, number>, signal: 'volume_spike' | 'keyword' = 'volume_spike') => ({
    signal, scope: 'issue' as const, subjectType: 'project' as const, subjectKey: 'p', title: 't', evidence,
    result: { triggered: true, suppressed: null, method: 'm', observed, baseline: {}, thresholds: {}, exceeded: [], limitations: [] } });
  const pubs = (k: number, neg = false) => Array.from({ length: k * 3 }, (_, i) => row(NOW - H, { publisher: `p${i % k}.example`, label: neg ? 'negative' : 'neutral' }));
  it('is a transparent sum of documented factors', () => {
    const s = computeSeverity(cand(pubs(12, true), { mentions: 120, ratio: 9 }), { topicRelevant: true, collectionStale: false, now: NOW, floor: null });
    expect(s.factors.map((f) => [f.factor, f.points])).toEqual([['absolute_volume', 3], ['change_vs_baseline', 3], ['independent_publishers', 3], ['negative_share', 2],
      ['topic_relevance', 1], ['evidence_quality', 0], ['data_freshness', 0], ['source_reliability', 0]]);
    expect(s).toMatchObject({ points: 12, severity: 'critical' });
  });
  it('critical requires at least three independent publishers', () => {
    const s = computeSeverity(cand(Array.from({ length: 120 }, () => row(NOW - H, { publisher: 'only.example', label: 'negative' })), { mentions: 120, ratio: 9 }),
      { topicRelevant: true, collectionStale: false, now: NOW, floor: null });
    expect(s.points).toBe(9); expect(s.severity).toBe('high'); expect(s.caps[0]).toMatch(/≥3 independent/);
  });
  it('weak evidence and stale collection lower the score; a rule floor raises it', () => {
    const weak = Array.from({ length: 6 }, () => row(NOW - 30 * H, { headlineOnly: true, uncertain: true }));
    const s = computeSeverity(cand(weak, { mentions: 6 }, 'keyword'), { topicRelevant: false, collectionStale: true, now: NOW, floor: null });
    expect(s.factors.find((f) => f.factor === 'evidence_quality')!.points).toBe(-1);
    expect(s.factors.find((f) => f.factor === 'data_freshness')!.points).toBe(-1);
    expect(s.severity).toBe('informational');
    expect(computeSeverity(cand(weak, { mentions: 6 }, 'keyword'), { topicRelevant: false, collectionStale: true, now: NOW, floor: 'high' }).severity).toBe('high');
  });
});
