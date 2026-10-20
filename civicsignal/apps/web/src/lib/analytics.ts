/** Client types and helpers for the analytics API (docs/ANALYTICS_METHODOLOGY.md). */
export interface Change { current: number; previous: number; delta: number; pct: number | null }
export interface Counts { positive: number; negative: number; neutral: number; mixed: number; unknown: number; unanalysed: number; uncertain: number }
export interface Shares { denominator: number; shares: Record<'positive' | 'negative' | 'neutral' | 'mixed', number | null>; uncertainShare: number | null; net: number | null }
export interface Freshness {
  asOf: string; latestMatchedAt: string | null; latestAnalysisAt: string | null; notes: string[];
  aggregates: { dataVersion: number; refreshedAt: string | null };
  sources: { enabled: number; healthy: number; unhealthy: number; stale: number; last_success_at: string | null; staleAfterHours: number;
    problems: Array<{ id: string; name: string; domain: string; health_status: string; last_success_at: string | null; consecutive_failures: number }> };
}
export interface Envelope {
  metric: string; period: { from: string; to: string; timezone: string; granularity: 'day' | 'week' | 'month'; days: number; boundaries: string };
  scope: { projects: number; projectId: string | null }; freshness: Freshness; cache: { hit: boolean; computedAt: string; expiresAt: string; dataVersion: number };
}
export interface SovEntity { id: string; name?: string; type?: string; articles: number; share: number | null; positive: number; negative: number }
export interface Overview extends Envelope {
  coverage: { totals: { records: number; articles: number; duplicates: number; publishers: number; sources: number; storyClusters: number; unclusteredArticles: number };
    change: { articles: Change; records: Change; publishers: Change }; rolling: Record<'day' | 'week' | 'month', Change & { days: number }>;
    timeline: { source: string; points: Array<{ bucket: string; articles: number; records: number }> } };
  sentiment: Shares & { counts: Counts; meanConfidence: number | null };
  shareOfVoice: { group: Array<{ id: string; name?: string; type?: string }>; entities: SovEntity[]; denominator: number; eligibleArticles: number; autoSelected: boolean; warnings: string[]; formula: string };
  topIssues: { statuses: string[]; top: Array<{ id: string; title: string; status: string; severity: string; severity_points: number; last_detected_at: string; project_name: string }>;
    bySeverity: Record<string, number>; highPriority: number; definition: string };
  trendingTopics: Array<{ key: string; label: string } & Change>; topTopics: Array<{ key: string; label: string; articles: number; openIssues: number } & Change>;
  entities: Array<{ id: string; name?: string; type?: string; articles: number; openIssues: number } & Change>;
  completeness: { articles: number; analysed: number; analysedShare: number | null; withoutPublishedAt: number; unknownLanguage: number; notes: string[] };
  definitions: Record<string, string>;
}
export interface SourcesResp extends Envelope {
  activePublishers: number; activeSources: number; registry: { enabled: number; registered: number }; totalArticles: number;
  diversity: { simpson: number | null; top5Share: number | null; definition: string }; medianLagMinutes: number | null;
  publishers: Array<{ domain: string; publisher: string | null; articles: number; records: number; share: number | null; activeDays: number; articlesPerActiveDay: number | null;
    medianLagMinutes: number | null; topTopics: Array<{ key: string; label: string; articles: number }>; sentiment: Shares & { counts: Counts } }>;
  page: { limit: number; offset: number; total: number }; notes: string[];
}

export interface Filters { range: string; from: string; to: string; projectId: string; entityId: string; topic: string; sourceId: string; language: string; sentiment: string; issueStatus: string; entityIds: string[] }
export const EMPTY_FILTERS: Filters = { range: '30', from: '', to: '', projectId: '', entityId: '', topic: '', sourceId: '', language: '', sentiment: '', issueStatus: '', entityIds: [] };

/** UTC instant of local midnight on `date` (YYYY-MM-DD) in `tz`, DST-safe (first valid instant). */
export function zonedMidnight(date: string, tz: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d);
  const off = (t: number) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - Math.floor(t / 1000) * 1000;
  };
  const cands = [guess - off(guess - 12 * 3_600_000), guess - off(guess + 12 * 3_600_000)];
  const local = (t: number) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).format(new Date(t));
  const valid = cands.filter((c) => local(c).startsWith(date));
  return new Date(valid.length ? Math.min(...valid) : Math.max(...cands));
}

/** Query string for the analytics API. Custom dates are whole local days in the tenant time zone; the end date is inclusive. */
export function analyticsQuery(f: Filters, tz: string): string {
  const p = new URLSearchParams();
  if (f.range === 'custom' && f.from && f.to) {
    p.set('from', zonedMidnight(f.from, tz).toISOString());
    const [y, m, d] = f.to.split('-').map(Number) as [number, number, number];
    const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
    p.set('to', zonedMidnight(next, tz).toISOString());
  } else p.set('days', f.range === 'custom' ? '30' : f.range);
  for (const k of ['projectId', 'entityId', 'topic', 'sourceId', 'language', 'sentiment', 'issueStatus'] as const) if (f[k]) p.set(k, f[k]);
  if (f.entityIds.length) p.set('entityIds', f.entityIds.join(','));
  return p.toString();
}

export const fmtN = (n: number | null | undefined, digits = 0) => (n == null ? '—' : n.toLocaleString('en-GB', { maximumFractionDigits: digits }));
export const fmtPct = (n: number | null | undefined) => (n == null ? '—' : `${fmtN(n, 1)}%`);
export function fmtChange(c: Pick<Change, 'delta' | 'pct'>): string {
  const sign = c.delta > 0 ? '+' : c.delta < 0 ? '−' : '±';
  return `${sign}${fmtN(Math.abs(c.delta))}${c.pct == null ? (c.delta ? ' (new)' : '') : ` (${c.pct > 0 ? '+' : c.pct < 0 ? '−' : ''}${fmtN(Math.abs(c.pct), 1)}%)`}`;
}
export function fmtPeriod(p: Envelope['period']): string {
  const f = (s: string) => new Date(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: p.timezone });
  const last = new Date(new Date(p.to).getTime() - 1).toISOString();
  return `${f(p.from)} – ${f(last)} (${p.timezone})`;
}
export const fmtBucket = (b: string, g: 'day' | 'week' | 'month') =>
  new Date(`${b}T00:00:00Z`).toLocaleDateString('en-GB', g === 'month' ? { month: 'short', year: 'numeric', timeZone: 'UTC' } : { day: 'numeric', month: 'short', timeZone: 'UTC' }) + (g === 'week' ? ' (wk)' : '');
