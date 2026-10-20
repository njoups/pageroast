import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { seesAllProjects, type Role } from '../authz/permissions';
import { badRequest, notFound } from '../common/errors';
import { Params } from '../analysis/filters';
import { DEFAULT_TOPICS } from '../analysis/taxonomy';
import { change, median, pct, sentimentShares, shareOfVoice, simpsonDiversity, type SentimentCounts } from './metrics';
import { note, texts, type Note } from './notes';
import { addDays, localParts, tzOffset, zonedToUtc } from './tz';

/** Analytics time of a record: publisher-reported time, else our collection time (docs/ANALYTICS_METHODOLOGY.md). */
export const T_EXPR = 'coalesce(m.published_at, m.discovered_at)';
export const LANG_EXPR = `lower(split_part(coalesce(m.detected_language, m.language, 'und'), '-', 1))`;
export const SENTIMENT_FILTERS = ['positive', 'negative', 'neutral', 'mixed', 'unknown', 'unanalysed'] as const;
export const ISSUE_STATUSES = ['detected', 'pending_review', 'acknowledged', 'investigating', 'resolved', 'closed'] as const;
const OPEN_ISSUE = ['detected', 'pending_review', 'acknowledged', 'investigating'];
const D = 86_400_000;
/** Issue statuses to include: the chosen one, all (reports, internal 'all'), or the open statuses by default. */
const issueStatuses = (s: Scope): string[] => (s.q.issueStatus === 'all' ? [...ISSUE_STATUSES] : s.q.issueStatus ? [s.q.issueStatus] : OPEN_ISSUE);

export type Granularity = 'day' | 'week' | 'month';
export interface AnalyticsParams {
  from?: string; to?: string; days?: number;
  projectId?: string; entityId?: string; topic?: string; sourceId?: string; language?: string; sentiment?: string; issueStatus?: string;
  granularity?: Granularity; entityIds?: string[]; limit?: number; offset?: number;
  /** news (default) = articles only; social = social-platform records only; all = both, explicitly. */
  channel?: 'news' | 'social' | 'all';
}
export interface Viewer { tenantId: string; userId: string; role: Role }
export interface Scope {
  viewer: Viewer; projects: string[]; from: Date; to: Date; tz: string; granularity: Granularity; q: AnalyticsParams;
}
export interface EngineOptions { now: Date; maxPeriodDays: number; cacheTtlSeconds: number; staleHours: number }

export const topicLabels: Record<string, string> = Object.fromEntries(DEFAULT_TOPICS.map((x) => [x.key, x.label]));

/**
 * Resolves who may see what and over which period. Projects are limited to those visible to the viewer (owners/admins:
 * all; other roles: assigned projects only); asking for an invisible project is a 404, exactly like the project API.
 * Periods are half-open [from, to). Defaults: the last 30 local days ending now.
 */
export async function resolveScope(c: PoolClient, viewer: Viewer, q: AnalyticsParams, o: Pick<EngineOptions, 'now' | 'maxPeriodDays'>): Promise<Scope> {
  const tz = ((await c.query<{ tz: string | null }>(`SELECT settings->>'timezone' AS tz FROM tenants WHERE id = $1`, [viewer.tenantId])).rows[0]?.tz) || 'Asia/Jakarta';
  const visible = seesAllProjects(viewer.role)
    ? (await c.query<{ id: string }>('SELECT id FROM projects ORDER BY id')).rows.map((r) => r.id)
    : (await c.query<{ id: string }>('SELECT project_id AS id FROM project_members WHERE user_id = $1 ORDER BY project_id', [viewer.userId])).rows.map((r) => r.id);
  if (q.projectId && !visible.includes(q.projectId)) throw notFound('Project');
  const projects = q.projectId ? [q.projectId] : visible;
  // Default end: the next whole minute, so dashboards polling within a minute share one cache entry.
  // Date-only bounds are calendar days in the tenant time zone: `from` is that day's local midnight and a date-only
  // `to` includes its whole day (ends at the next local midnight). Timestamps keep their exact, half-open meaning.
  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  const localMidnight = (s: string, plusDays = 0) => { const [y, m, d] = s.split('-').map(Number) as [number, number, number]; const n = addDays(y, m, d, plusDays); return zonedToUtc(n.y, n.m, n.d, 0, 0, tz); };
  const to = q.to ? (DAY.test(q.to) ? localMidnight(q.to, 1) : new Date(q.to)) : new Date(Math.ceil(o.now.getTime() / 60_000) * 60_000);
  let from: Date;
  if (q.from) from = DAY.test(q.from) ? localMidnight(q.from) : new Date(q.from);
  else {
    const p = localParts(to, tz); const s = addDays(p.y, p.m, p.d, -((q.days ?? 30) - 1));
    from = zonedToUtc(s.y, s.m, s.d, 0, 0, tz);
  }
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw badRequest('validation_failed', 'Invalid period');
  if (from >= to) throw badRequest('validation_failed', '`from` must be before `to`');
  if (to.getTime() - from.getTime() > o.maxPeriodDays * D) throw badRequest('period_too_long', `The period may span at most ${o.maxPeriodDays} days`);
  const span = (to.getTime() - from.getTime()) / D;
  const granularity = q.granularity ?? (span > 120 ? 'month' : span > 35 ? 'week' : 'day');
  return { viewer, projects, from, to, tz, granularity, q };
}

/** WHERE conditions over `mentions m` for a scope and a period (originals only unless `allRecords`). */
function conds(p: Params, s: Scope, from: Date, to: Date, o: { allRecords?: boolean; skipEntity?: boolean } = {}): string {
  const w = [`${T_EXPR} >= ${p.add(from)}`, `${T_EXPR} < ${p.add(to)}`,
    `EXISTS (SELECT 1 FROM mention_matches mm WHERE mm.mention_id = m.id AND mm.project_id = ANY(${p.add(s.projects)}::uuid[]))`];
  if (!o.allRecords) w.push(`m.duplicate_status = 'original'`);
  const q = s.q;
  // News and social records are never combined silently: executive analytics default to news articles.
  const channel = q.channel ?? 'news';
  if (channel === 'news') w.push('m.platform IS NULL');
  else if (channel === 'social') w.push('m.platform IS NOT NULL');
  if (q.sourceId) w.push(`m.source_id = ${p.add(q.sourceId)}`);
  if (q.language) w.push(`${LANG_EXPR} = ${p.add(q.language)}`);
  if (q.topic) w.push(`EXISTS (SELECT 1 FROM mention_topics mt WHERE mt.mention_id = m.id AND mt.analysis_id = m.analysis_id AND mt.topic_key = ${p.add(q.topic)})`);
  if (q.entityId && !o.skipEntity) w.push(`EXISTS (SELECT 1 FROM mention_entities me WHERE me.mention_id = m.id AND me.analysis_id = m.analysis_id AND me.entity_id = ${p.add(q.entityId)})`);
  if (q.sentiment === 'unanalysed') w.push('m.analysis_id IS NULL');
  else if (q.sentiment) {
    w.push(`m.analysis_id IS NOT NULL`);
    w.push(`coalesce((SELECT sr.label FROM sentiment_results sr WHERE sr.analysis_id = m.analysis_id AND sr.target_type = 'article' LIMIT 1), 'unknown') = ${p.add(q.sentiment)}`);
  }
  return w.join(' AND ');
}

/** Local bucket key (YYYY-MM-DD of the bucket's first local day) for a timestamp column. */
const bucketSql = (p: Params, s: Scope, col: string) => `to_char(date_trunc(${p.add(s.granularity)}, ${col} AT TIME ZONE ${p.add(s.tz)}), 'YYYY-MM-DD')`;

/** Every bucket key in [from, to), so empty buckets are shown as 0 instead of being skipped. */
export function bucketKeys(from: Date, to: Date, tz: string, g: Granularity): string[] {
  const keys: string[] = [];
  const f = localParts(from, tz);
  let cur = { y: f.y, m: f.m, d: f.d };
  if (g === 'week') { const wd = f.weekday; cur = addDays(f.y, f.m, f.d, -(wd - 1)); }
  if (g === 'month') cur = { y: f.y, m: f.m, d: 1 };
  for (let i = 0; i < 1000; i++) {
    const start = zonedToUtc(cur.y, cur.m, cur.d, 0, 0, tz);
    if (start >= to) break;
    keys.push(`${cur.y}-${String(cur.m).padStart(2, '0')}-${String(cur.d).padStart(2, '0')}`);
    cur = g === 'day' ? addDays(cur.y, cur.m, cur.d, 1) : g === 'week' ? addDays(cur.y, cur.m, cur.d, 7) : (cur.m === 12 ? { y: cur.y + 1, m: 1, d: 1 } : { y: cur.y, m: cur.m + 1, d: 1 });
  }
  return keys;
}

const previousRange = (s: Scope) => { const len = s.to.getTime() - s.from.getTime(); return { from: new Date(s.from.getTime() - len), to: s.from }; };
const n = (v: unknown) => Number(v ?? 0);

// ── Freshness and completeness ─────────────────────────────────────────────────────────────────────

export async function freshness(c: PoolClient, s: Scope, o: Pick<EngineOptions, 'now' | 'staleHours'>) {
  const state = (await c.query(`SELECT data_version, refreshed_at FROM analytics_state`)).rows[0] ?? null;
  const latest = (await c.query(`SELECT max(matched_at) AS matched FROM mention_matches WHERE project_id = ANY($1::uuid[])`, [s.projects])).rows[0];
  const analysed = (await c.query(`SELECT max(finished_at) AS at FROM mention_analyses WHERE status IN ('succeeded','partial')`)).rows[0];
  const sources = (await c.query(`SELECT count(*) FILTER (WHERE enabled)::int AS enabled, count(*) FILTER (WHERE enabled AND health_status = 'healthy')::int AS healthy,
      count(*) FILTER (WHERE enabled AND health_status IN ('degraded','failing'))::int AS unhealthy,
      count(*) FILTER (WHERE enabled AND (last_success_at IS NULL OR last_success_at < $1))::int AS stale, max(last_success_at) AS last_success_at
    FROM sources`, [new Date(o.now.getTime() - o.staleHours * 3_600_000)])).rows[0];
  const problems = (await c.query(`SELECT id, name, domain, health_status, last_success_at, consecutive_failures FROM sources
    WHERE enabled AND (health_status IN ('degraded','failing') OR last_success_at IS NULL OR last_success_at < $1) ORDER BY last_success_at NULLS FIRST LIMIT 10`,
    [new Date(o.now.getTime() - o.staleHours * 3_600_000)])).rows;
  const keys: Note[] = [];
  if (sources.enabled === 0) keys.push(note('no_sources_enabled'));
  if (sources.stale > 0) keys.push(note('stale_sources', { n: sources.stale, hours: o.staleHours }));
  if (o.now.getTime() - s.to.getTime() < 3_600_000)
    keys.push(note('period_open'));
  return {
    asOf: o.now.toISOString(),
    latestMatchedAt: latest.matched, latestAnalysisAt: analysed.at,
    aggregates: state ? { dataVersion: Number(state.data_version), refreshedAt: state.refreshed_at } : { dataVersion: 0, refreshedAt: null },
    sources: { ...sources, staleAfterHours: o.staleHours, problems },
    notes: texts(keys), noteKeys: keys,
  };
}

async function completeness(c: PoolClient, s: Scope) {
  const p = new Params();
  const r = (await c.query(`SELECT count(*)::int AS articles, count(*) FILTER (WHERE m.analysis_id IS NOT NULL)::int AS analysed,
      count(*) FILTER (WHERE m.published_at IS NULL)::int AS no_published_at, count(*) FILTER (WHERE ${LANG_EXPR} = 'und')::int AS unknown_language
    FROM mentions m WHERE ${conds(p, s, s.from, s.to)}`, p.values)).rows[0];
  return {
    articles: r.articles, analysed: r.analysed, analysedShare: pct(r.analysed, r.articles),
    withoutPublishedAt: r.no_published_at, unknownLanguage: r.unknown_language,
    notes: [
      ...(r.articles && r.analysed < r.articles ? [`${r.articles - r.analysed} of ${r.articles} articles are not analysed yet; tone, topics and entities exclude them.`] : []),
      ...(r.no_published_at ? [`${r.no_published_at} article(s) have no publisher date and are placed at their collection time.`] : []),
    ],
  };
}

// ── Coverage ───────────────────────────────────────────────────────────────────────────────────────

async function coverageTotals(c: PoolClient, s: Scope, from: Date, to: Date) {
  const p = new Params();
  const r = (await c.query(`SELECT count(*)::int AS records, count(*) FILTER (WHERE m.duplicate_status = 'original')::int AS articles,
      count(DISTINCT m.publisher_domain) FILTER (WHERE m.duplicate_status = 'original')::int AS publishers,
      count(DISTINCT m.source_id) FILTER (WHERE m.duplicate_status = 'original')::int AS sources,
      count(DISTINCT m.cluster_id) FILTER (WHERE m.duplicate_status = 'original')::int AS clusters,
      count(*) FILTER (WHERE m.duplicate_status = 'original' AND m.cluster_id IS NULL)::int AS unclustered
    FROM mentions m WHERE ${conds(p, s, from, to, { allRecords: true })}`, p.values)).rows[0];
  return { records: r.records, articles: r.articles, duplicates: r.records - r.articles, publishers: r.publishers, sources: r.sources, storyClusters: r.clusters, unclusteredArticles: r.unclustered };
}

/**
 * Timeline of articles and records per local bucket. Uses the hourly aggregate when it is current and can answer the
 * query exactly (one project, filters it stores, hour-aligned period, whole-hour zone offset); otherwise base tables.
 */
async function coverageTimeline(c: PoolClient, s: Scope, stamp: Stamp, expectArticles?: number, expectRecords?: number): Promise<{ source: string; points: Array<{ bucket: string; articles: number; records: number }> }> {
  const q = s.q;
  const hourAligned = s.from.getTime() % 3_600_000 === 0 && s.to.getTime() % 3_600_000 === 0
    && tzOffset(s.from.getTime(), s.tz) % 3_600_000 === 0 && tzOffset(s.to.getTime(), s.tz) % 3_600_000 === 0;
  const aggCurrent = stamp.aggregatesCurrent;
  const useAgg = s.projects.length === 1 && !q.entityId && !q.topic && hourAligned && aggCurrent && (q.channel ?? 'news') === 'news'; // aggregate holds news only
  const p = new Params();
  let rows: Array<{ bucket: string; articles: number; records: number }>;
  if (useAgg) {
    const w = [`project_id = ${p.add(s.projects[0])}`, `hour >= ${p.add(s.from)}`, `hour < ${p.add(s.to)}`];
    if (q.sourceId) w.push(`source_id = ${p.add(q.sourceId)}`);
    if (q.language) w.push(`language = ${p.add(q.language)}`);
    if (q.sentiment) w.push(`sentiment = ${p.add(q.sentiment)}`);
    rows = (await c.query(`SELECT ${bucketSql(p, s, 'hour')} AS bucket, sum(articles)::int AS articles, sum(records)::int AS records
      FROM analytics_hourly WHERE ${w.join(' AND ')} GROUP BY 1`, p.values)).rows;
  } else {
    rows = (await c.query(`SELECT ${bucketSql(p, s, T_EXPR)} AS bucket, count(*) FILTER (WHERE m.duplicate_status = 'original')::int AS articles, count(*)::int AS records
      FROM mentions m WHERE ${conds(p, s, s.from, s.to, { allRecords: true })} GROUP BY 1`, p.values)).rows;
  }
  // Self-check: the aggregate must add up to the base-table totals (deletions do not move the watermarks). If it
  // does not, the base tables answer instead and the next refresh repairs the aggregate.
  if (useAgg && expectArticles !== undefined && (rows.reduce((a, r) => a + r.articles, 0) !== expectArticles || rows.reduce((a, r) => a + r.records, 0) !== expectRecords)) {
    return coverageTimeline(c, s, { ...stamp, aggregatesCurrent: false });
  }
  const by = new Map(rows.map((r) => [r.bucket, r]));
  return {
    source: useAgg ? 'hourly_aggregate' : 'base_tables',
    points: bucketKeys(s.from, s.to, s.tz, s.granularity).map((b) => ({ bucket: b, articles: by.get(b)?.articles ?? 0, records: by.get(b)?.records ?? 0 })),
  };
}

export async function coverage(c: PoolClient, s: Scope) {
  const stamp = await dataStamp(c);
  const cur = await coverageTotals(c, s, s.from, s.to);
  const prev = previousRange(s);
  const before = await coverageTotals(c, s, prev.from, prev.to);
  // Rolling comparisons ending at `to`: last day / 7 days / 30 days vs the equal window before.
  const p = new Params(); const to = s.to.getTime();
  const windows = [1, 7, 30] as const;
  const filters = windows.flatMap((w) => [
    `count(*) FILTER (WHERE ${T_EXPR} >= ${p.add(new Date(to - w * D))})::int AS c${w}`,
    `count(*) FILTER (WHERE ${T_EXPR} < ${p.add(new Date(to - w * D))} AND ${T_EXPR} >= ${p.add(new Date(to - 2 * w * D))})::int AS p${w}`]);
  const roll = (await c.query(`SELECT ${filters.join(', ')} FROM mentions m WHERE ${conds(p, s, new Date(to - 60 * D), s.to)}`, p.values)).rows[0];
  return {
    totals: cur,
    previousPeriod: { from: prev.from.toISOString(), to: prev.to.toISOString(), totals: before },
    change: { articles: change(cur.articles, before.articles), records: change(cur.records, before.records), publishers: change(cur.publishers, before.publishers) },
    rolling: Object.fromEntries(windows.map((w) => [w === 1 ? 'day' : w === 7 ? 'week' : 'month', { days: w, ...change(n(roll[`c${w}`]), n(roll[`p${w}`])) }])),
    timeline: await coverageTimeline(c, s, stamp, cur.articles, cur.records),
    definitions: {
      records: 'Collected records matching the selected projects, including duplicates and syndicated copies.',
      articles: 'Unique articles: records that are not duplicates or near-duplicates of an earlier record.',
      publishers: 'Distinct publisher domains among unique articles.',
      storyClusters: 'Distinct related-story clusters among unique articles (articles not yet clustered are counted separately).',
      rolling: 'Unique articles in the last 1/7/30 days ending at the period end, against the equal window before it.',
    },
  };
}

// ── Sentiment ──────────────────────────────────────────────────────────────────────────────────────

const LABEL_SQL = `CASE WHEN m.analysis_id IS NULL THEN 'unanalysed' ELSE coalesce(sr.label, 'unknown') END`;
const SR_JOIN = `LEFT JOIN sentiment_results sr ON sr.analysis_id = m.analysis_id AND sr.target_type = 'article'`;
const emptyCounts = (): SentimentCounts => ({ positive: 0, negative: 0, neutral: 0, mixed: 0, unknown: 0, unanalysed: 0, uncertain: 0 });
function fold(rows: Array<{ label: string; uncertain?: boolean; n: number }>): SentimentCounts {
  const c = emptyCounts();
  for (const r of rows) {
    (c as unknown as Record<string, number>)[r.label] = ((c as unknown as Record<string, number>)[r.label] ?? 0) + n(r.n);
    if (r.uncertain && ['positive', 'negative', 'neutral', 'mixed'].includes(r.label)) c.uncertain += n(r.n);
  }
  return c;
}

async function sentimentTotals(c: PoolClient, s: Scope, from: Date, to: Date) {
  const p = new Params();
  const rows = (await c.query(`SELECT ${LABEL_SQL} AS label, coalesce(sr.uncertain, false) AS uncertain, count(*)::int AS n, avg(sr.confidence)::float AS conf
    FROM mentions m ${SR_JOIN} WHERE ${conds(p, s, from, to)} GROUP BY 1, 2`, p.values)).rows;
  const counts = fold(rows);
  const confRows = rows.filter((r) => r.conf != null);
  const weighted = confRows.reduce((a, r) => a + r.conf * r.n, 0); const wn = confRows.reduce((a, r) => a + r.n, 0);
  return { counts, ...sentimentShares(counts), meanConfidence: wn ? Math.round((weighted / wn) * 1000) / 1000 : null };
}

async function sentimentBy(c: PoolClient, s: Scope, dim: 'topic' | 'entity' | 'publisher', limit = 10) {
  const p = new Params();
  const join = dim === 'topic' ? 'JOIN mention_topics x ON x.mention_id = m.id AND x.analysis_id = m.analysis_id'
    : dim === 'entity' ? 'JOIN mention_entities x ON x.mention_id = m.id AND x.analysis_id = m.analysis_id JOIN entities e ON e.id = x.entity_id' : '';
  const key = dim === 'topic' ? 'x.topic_key' : dim === 'entity' ? 'x.entity_id::text' : 'm.publisher_domain';
  const label = dim === 'entity' ? 'max(e.display_name)' : dim === 'topic' ? 'NULL' : 'max(m.publisher)';
  const rows = (await c.query(`WITH base AS (
      SELECT ${key} AS k, ${label} AS name, ${LABEL_SQL} AS label, coalesce(sr.uncertain, false) AS uncertain, count(DISTINCT m.id)::int AS n
      FROM mentions m ${SR_JOIN} ${join} WHERE ${conds(p, s, s.from, s.to)} GROUP BY 1, 3, 4),
    top AS (SELECT k, sum(n) AS total FROM base GROUP BY k ORDER BY total DESC, k LIMIT ${p.add(limit)})
    SELECT base.*, top.total FROM base JOIN top USING (k) ORDER BY top.total DESC, k`, p.values)).rows;
  const groups = new Map<string, { key: string; name: string | null; rows: typeof rows }>();
  for (const r of rows) { const g = groups.get(r.k) ?? { key: r.k, name: r.name, rows: [] as typeof rows }; g.rows.push(r); if (r.name) g.name = r.name; groups.set(r.k, g); }
  return [...groups.values()].map((g) => {
    const counts = fold(g.rows);
    return { key: g.key, label: dim === 'topic' ? (topicLabels[g.key] ?? g.key) : g.name ?? g.key, articles: g.rows.reduce((a, r) => a + n(r.n), 0), counts, ...sentimentShares(counts) };
  });
}

export async function sentiment(c: PoolClient, s: Scope) {
  const cur = await sentimentTotals(c, s, s.from, s.to);
  const prev = previousRange(s);
  const before = await sentimentTotals(c, s, prev.from, prev.to);
  const p = new Params();
  const tl = (await c.query(`SELECT ${bucketSql(p, s, T_EXPR)} AS bucket, ${LABEL_SQL} AS label, coalesce(sr.uncertain, false) AS uncertain, count(*)::int AS n
    FROM mentions m ${SR_JOIN} WHERE ${conds(p, s, s.from, s.to)} GROUP BY 1, 2, 3`, p.values)).rows;
  const byBucket = new Map<string, typeof tl>();
  for (const r of tl) { const a = byBucket.get(r.bucket) ?? []; a.push(r); byBucket.set(r.bucket, a); }
  const p2 = new Params();
  const methods = (await c.query(`SELECT a.method, a.provider, count(*)::int AS n FROM mentions m JOIN mention_analyses a ON a.id = m.analysis_id
    WHERE ${conds(p2, s, s.from, s.to)} GROUP BY 1, 2 ORDER BY 3 DESC`, p2.values)).rows;
  const lim: Note[] = [];
  if (cur.denominator < 30) lim.push(note('small_tone_sample', { n: cur.denominator }));
  if (cur.counts.unanalysed) lim.push(note('unanalysed', { n: cur.counts.unanalysed }));
  if (methods.some((m) => m.method === 'baseline')) lim.push(note('baseline_method'));
  if (cur.uncertainShare != null && cur.uncertainShare > 30) lim.push(note('uncertain_share', { pct: cur.uncertainShare }));
  return {
    totals: cur,
    previousPeriod: { from: prev.from.toISOString(), to: prev.to.toISOString(), totals: before },
    netChange: cur.net != null && before.net != null ? Math.round((cur.net - before.net) * 10) / 10 : null,
    timeline: bucketKeys(s.from, s.to, s.tz, s.granularity).map((b) => { const counts = fold(byBucket.get(b) ?? []); return { bucket: b, counts, ...sentimentShares(counts) }; }),
    byTopic: await sentimentBy(c, s, 'topic'), byEntity: await sentimentBy(c, s, 'entity'), bySource: await sentimentBy(c, s, 'publisher'),
    methods, limitations: texts(lim), limitationKeys: lim,
    definitions: {
      proportions: 'Share of articles with a known tone (positive, negative, neutral, mixed). Unknown and not-yet-analysed articles are excluded from the denominator and shown separately.',
      net: 'Positive share minus negative share, in percentage points of the known-tone denominator.',
      uncertain: 'Known labels whose confidence was below the analysis threshold.',
      byEntity: 'Article-level tone of articles that mention the entity; this is not necessarily the tone toward the entity.',
    },
  };
}

// ── Share of voice ─────────────────────────────────────────────────────────────────────────────────

export async function shareOfVoiceMetric(c: PoolClient, s: Scope) {
  let group = s.q.entityIds ?? [];
  let autoSelected = false;
  if (!group.length) {
    const p = new Params();
    group = (await c.query(`SELECT me.entity_id FROM mentions m JOIN mention_entities me ON me.mention_id = m.id AND me.analysis_id = m.analysis_id
      WHERE ${conds(p, s, s.from, s.to, { skipEntity: true })} AND me.entity_type NOT IN ('location','event') GROUP BY 1 ORDER BY count(DISTINCT m.id) DESC, 1 LIMIT 5`, p.values)).rows.map((r) => r.entity_id);
    autoSelected = true;
  }
  const ents = group.length ? (await c.query(`SELECT id, display_name, entity_type FROM entities WHERE id = ANY($1::uuid[])`, [group])).rows : [];
  if (ents.length !== group.length) throw notFound('Entity');
  const p = new Params();
  const counts = group.length ? (await c.query(`SELECT me.entity_id, count(DISTINCT m.id)::int AS articles,
      count(DISTINCT m.id) FILTER (WHERE sr.label = 'positive')::int AS positive, count(DISTINCT m.id) FILTER (WHERE sr.label = 'negative')::int AS negative
    FROM mentions m JOIN mention_entities me ON me.mention_id = m.id AND me.analysis_id = m.analysis_id ${SR_JOIN}
    WHERE ${conds(p, s, s.from, s.to, { skipEntity: true })} AND me.entity_id = ANY(${p.add(group)}::uuid[]) GROUP BY 1`, p.values)).rows : [];
  const p2 = new Params();
  const eligible = group.length ? n((await c.query(`SELECT count(DISTINCT m.id)::int AS n FROM mentions m JOIN mention_entities me ON me.mention_id = m.id AND me.analysis_id = m.analysis_id
    WHERE ${conds(p2, s, s.from, s.to, { skipEntity: true })} AND me.entity_id = ANY(${p2.add(group)}::uuid[])`, p2.values)).rows[0].n) : 0;
  const p3 = new Params();
  const tl = group.length ? (await c.query(`SELECT ${bucketSql(p3, s, T_EXPR)} AS bucket, me.entity_id, count(DISTINCT m.id)::int AS articles
    FROM mentions m JOIN mention_entities me ON me.mention_id = m.id AND me.analysis_id = m.analysis_id
    WHERE ${conds(p3, s, s.from, s.to, { skipEntity: true })} AND me.entity_id = ANY(${p3.add(group)}::uuid[]) GROUP BY 1, 2`, p3.values)).rows : [];
  const p4 = new Params();
  const analysedInScope = n((await c.query(`SELECT count(*) FILTER (WHERE m.analysis_id IS NOT NULL)::int AS a FROM mentions m WHERE ${conds(p4, s, s.from, s.to, { skipEntity: true })}`, p4.values)).rows[0].a);
  const byId = new Map(counts.map((r) => [r.entity_id, r]));
  const sov = shareOfVoice(group.map((id) => ({ id, articles: byId.get(id)?.articles ?? 0 })), eligible);
  const meta = new Map(ents.map((e) => [e.id, e]));
  const warn: Note[] = [];
  const types = new Set(ents.map((e) => e.entity_type));
  if (types.size > 1) warn.push(note('sov_mixed_types', { types: [...types].join(', ') }));
  if (eligible < 30) warn.push(note('sov_small_sample', { n: eligible }));
  if (sov.coMentionArticles > 0) warn.push(note('sov_co_mentions', { n: sov.coMentionArticles }));
  if (autoSelected) warn.push(note('sov_auto_group'));
  if (s.q.entityId) warn.push(note('sov_entity_filter_ignored'));
  return {
    group: group.map((id) => ({ id, name: meta.get(id)?.display_name, type: meta.get(id)?.entity_type })), autoSelected,
    ...sov,
    entities: sov.entities.map((e) => ({ ...e, name: meta.get(e.id)?.display_name, type: meta.get(e.id)?.entity_type,
      positive: byId.get(e.id)?.positive ?? 0, negative: byId.get(e.id)?.negative ?? 0 })),
    timeline: bucketKeys(s.from, s.to, s.tz, s.granularity).map((b) => {
      const rows = tl.filter((r) => r.bucket === b); const total = rows.reduce((a, r) => a + r.articles, 0);
      return { bucket: b, total, shares: Object.fromEntries(group.map((id) => { const v = rows.find((r) => r.entity_id === id)?.articles ?? 0; return [id, { articles: v, share: pct(v, total) }]; })) };
    }),
    analysedArticlesInScope: analysedInScope,
    formula: 'SoV(e) = unique articles mentioning e ÷ Σ unique articles mentioning each entity in the group × 100. Shares sum to 100%.',
    rules: {
      duplicates: 'Unique articles only; duplicates and syndicated copies are excluded.',
      matching: 'Entity mentions from the current analysis of each article, after alias resolution to the canonical entity. No fuzzy matching at query time.',
      sources: 'Only sources collected for the selected projects; coverage outside them is not represented.',
      excluded: 'No reach, audience, impression or advertising-value estimates are used or implied.',
    },
    warnings: texts(warn), warningKeys: warn,
  };
}

// ── Sources ────────────────────────────────────────────────────────────────────────────────────────

export async function sources(c: PoolClient, s: Scope) {
  const limit = Math.min(s.q.limit ?? 25, 100); const offset = s.q.offset ?? 0;
  const p = new Params();
  const w = conds(p, s, s.from, s.to, { allRecords: true });
  const tzp = p.add(s.tz);
  const all = (await c.query(`SELECT m.publisher_domain AS domain, max(m.publisher) AS publisher, count(*) FILTER (WHERE m.duplicate_status = 'original')::int AS articles, count(*)::int AS records,
      count(DISTINCT (${T_EXPR} AT TIME ZONE ${tzp})::date)::int AS active_days, min(${T_EXPR}) AS first_at, max(${T_EXPR}) AS last_at,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM m.discovered_at - m.published_at) / 60) FILTER (WHERE m.published_at IS NOT NULL AND m.discovered_at >= m.published_at) AS lag_minutes,
      count(*) FILTER (WHERE m.published_at IS NULL)::int AS undated
    FROM mentions m WHERE ${w} GROUP BY 1 ORDER BY 3 DESC, 1`, p.values)).rows;
  const totalArticles = all.reduce((a, r) => a + r.articles, 0);
  const page = all.slice(offset, offset + limit);
  const domains = page.map((r) => r.domain);
  const p2 = new Params();
  const topics = domains.length ? (await c.query(`SELECT m.publisher_domain AS domain, mt.topic_key, count(DISTINCT m.id)::int AS n
    FROM mentions m JOIN mention_topics mt ON mt.mention_id = m.id AND mt.analysis_id = m.analysis_id
    WHERE ${conds(p2, s, s.from, s.to)} AND m.publisher_domain = ANY(${p2.add(domains)}) GROUP BY 1, 2 ORDER BY 3 DESC`, p2.values)).rows : [];
  const p3 = new Params();
  const tone = domains.length ? (await c.query(`SELECT m.publisher_domain AS domain, ${LABEL_SQL} AS label, coalesce(sr.uncertain, false) AS uncertain, count(*)::int AS n
    FROM mentions m ${SR_JOIN} WHERE ${conds(p3, s, s.from, s.to)} AND m.publisher_domain = ANY(${p3.add(domains)}) GROUP BY 1, 2, 3`, p3.values)).rows : [];
  const reg = (await c.query(`SELECT count(*) FILTER (WHERE enabled)::int AS enabled, count(*)::int AS registered FROM sources`)).rows[0];
  const sorted = all.map((r) => r.articles).sort((a, b) => b - a);
  return {
    activePublishers: all.filter((r) => r.articles > 0).length,
    activeSources: (await coverageTotals(c, s, s.from, s.to)).sources,
    registry: reg,
    totalArticles,
    diversity: { simpson: simpsonDiversity(all.map((r) => r.articles)), top5Share: pct(sorted.slice(0, 5).reduce((a, b) => a + b, 0), totalArticles),
      definition: 'Simpson diversity 1 − Σp² over publisher shares of unique articles (0 = a single publisher; closer to 1 = spread across many).' },
    medianLagMinutes: median(all.map((r) => r.lag_minutes).filter((x): x is number => x != null)),
    publishers: page.map((r) => {
      const counts = fold(tone.filter((x) => x.domain === r.domain));
      return {
        domain: r.domain, publisher: r.publisher, articles: r.articles, records: r.records, share: pct(r.articles, totalArticles),
        activeDays: r.active_days, firstAt: r.first_at, lastAt: r.last_at, articlesPerActiveDay: r.active_days ? Math.round((r.articles / r.active_days) * 10) / 10 : null,
        medianLagMinutes: r.lag_minutes == null ? null : Math.round(r.lag_minutes), undated: r.undated,
        topTopics: topics.filter((x) => x.domain === r.domain).slice(0, 3).map((x) => ({ key: x.topic_key, label: topicLabels[x.topic_key] ?? x.topic_key, articles: x.n })),
        sentiment: { counts, ...sentimentShares(counts) },
      };
    }),
    page: { limit, offset, total: all.length },
    notes: [
      'Publishing frequency is not a measure of credibility, accuracy or influence.',
      'Collection lag = our collection time minus the publisher-reported time; it reflects feed and polling delays, not publisher speed alone.',
    ],
  };
}

// ── Topics and entities ────────────────────────────────────────────────────────────────────────────

/** Emerging = at least `minCount` articles now and either new or up ≥ 50% against the previous equal period. Not a forecast. */
function emerging<T extends { current: number; previous: number }>(rows: T[], minCount = 3) {
  return rows.filter((r) => r.current >= minCount && (r.previous === 0 || r.current >= r.previous * 1.5))
    .sort((a, b) => (b.current - b.previous) - (a.current - a.previous)).slice(0, 10);
}

async function issueCounts(c: PoolClient, s: Scope, subjectType: 'topic' | 'entity') {
  const statuses = issueStatuses(s);
  return (await c.query(`SELECT subject_key, count(*)::int AS n, max(severity_points)::int AS max_points FROM detected_issues
    WHERE project_id = ANY($1::uuid[]) AND subject_type = $2 AND status = ANY($3) AND last_detected_at >= $4 AND first_detected_at < $5 GROUP BY 1`,
    [s.projects, subjectType, statuses, s.from, s.to])).rows;
}

export async function topics(c: PoolClient, s: Scope) {
  const prev = previousRange(s);
  const count = async (from: Date, to: Date) => {
    const p = new Params();
    return (await c.query(`SELECT mt.topic_key, max(pt.label) AS custom_label, count(DISTINCT m.id)::int AS n
      FROM mentions m JOIN mention_topics mt ON mt.mention_id = m.id AND mt.analysis_id = m.analysis_id LEFT JOIN project_topics pt ON pt.id = mt.project_topic_id
      WHERE ${conds(p, s, from, to)} GROUP BY 1`, p.values)).rows;
  };
  const cur = await count(s.from, s.to); const before = await count(prev.from, prev.to);
  const p = new Params();
  const analysed = n((await c.query(`SELECT count(*) FILTER (WHERE m.analysis_id IS NOT NULL)::int AS n FROM mentions m WHERE ${conds(p, s, s.from, s.to)}`, p.values)).rows[0].n);
  const prevBy = new Map(before.map((r) => [r.topic_key, r.n]));
  const issues = new Map((await issueCounts(c, s, 'topic')).map((r) => [r.subject_key, r]));
  const rows = cur.map((r) => ({ key: r.topic_key, label: r.custom_label ?? topicLabels[r.topic_key] ?? r.topic_key, ...change(r.n, prevBy.get(r.topic_key) ?? 0),
    articles: r.n, shareOfAnalysed: pct(r.n, analysed), openIssues: issues.get(r.topic_key)?.n ?? 0 })).sort((a, b) => b.articles - a.articles || a.key.localeCompare(b.key));
  const top5 = rows.filter((r) => r.key !== 'unknown').slice(0, 5).map((r) => r.key);
  const p2 = new Params();
  const tl = top5.length ? (await c.query(`SELECT ${bucketSql(p2, s, T_EXPR)} AS bucket, mt.topic_key, count(DISTINCT m.id)::int AS n
    FROM mentions m JOIN mention_topics mt ON mt.mention_id = m.id AND mt.analysis_id = m.analysis_id
    WHERE ${conds(p2, s, s.from, s.to)} AND mt.topic_key = ANY(${p2.add(top5)}) GROUP BY 1, 2`, p2.values)).rows : [];
  return {
    analysedArticles: analysed, topics: rows.slice(0, s.q.limit ?? 25),
    emerging: emerging(rows.filter((r) => r.key !== 'unknown')),
    trends: { keys: top5, points: bucketKeys(s.from, s.to, s.tz, s.granularity).map((b) => ({ bucket: b, ...Object.fromEntries(top5.map((k) => [k, tl.find((r) => r.bucket === b && r.topic_key === k)?.n ?? 0])) })) },
    definitions: {
      articles: 'Unique analysed articles carrying the topic in their current analysis (an article can carry up to three topics, so topics do not sum to the total).',
      emerging: 'At least 3 articles in the period and new, or up at least 50% on the previous equal-length period. Descriptive, not a forecast.',
      openIssues: 'Detected issues for the topic overlapping the period, in the chosen issue status (default: open statuses).',
    },
  };
}

export async function entities(c: PoolClient, s: Scope) {
  const prev = previousRange(s);
  const count = async (from: Date, to: Date) => {
    const p = new Params();
    return (await c.query(`SELECT me.entity_id, count(DISTINCT m.id)::int AS n FROM mentions m JOIN mention_entities me ON me.mention_id = m.id AND me.analysis_id = m.analysis_id
      WHERE ${conds(p, s, from, to, { skipEntity: true })} GROUP BY 1`, p.values)).rows;
  };
  const cur = await count(s.from, s.to); const before = await count(prev.from, prev.to);
  const prevBy = new Map(before.map((r) => [r.entity_id, r.n]));
  const ids = cur.map((r) => r.entity_id);
  const meta = new Map((ids.length ? (await c.query(`SELECT id, display_name, entity_type FROM entities WHERE id = ANY($1::uuid[])`, [ids])).rows : []).map((e) => [e.id, e]));
  const p = new Params();
  const toward = ids.length ? (await c.query(`SELECT sr.target_entity_id AS id, sr.label, count(DISTINCT m.id)::int AS n FROM mentions m
    JOIN sentiment_results sr ON sr.analysis_id = m.analysis_id AND sr.target_type = 'entity'
    WHERE ${conds(p, s, s.from, s.to, { skipEntity: true })} GROUP BY 1, 2`, p.values)).rows : [];
  const issues = new Map((await issueCounts(c, s, 'entity')).map((r) => [r.subject_key, r]));
  const rows = cur.map((r) => {
    const e = meta.get(r.entity_id);
    const t = toward.filter((x) => x.id === r.entity_id);
    return { id: r.entity_id, name: e?.display_name, type: e?.entity_type, articles: r.n, ...change(r.n, prevBy.get(r.entity_id) ?? 0),
      toneToward: t.length ? Object.fromEntries(t.map((x) => [x.label, x.n])) : null, openIssues: issues.get(r.entity_id)?.n ?? 0 };
  }).sort((a, b) => b.articles - a.articles || String(a.name).localeCompare(String(b.name)));
  // Co-occurrence: with the filtered entity if one is set, otherwise among the top 10.
  const focus = s.q.entityId ? [s.q.entityId] : rows.slice(0, 10).map((r) => r.id);
  const p2 = new Params();
  const pairs = focus.length ? (await c.query(`SELECT x.entity_id AS a, y.entity_id AS b, count(DISTINCT m.id)::int AS n
    FROM mentions m JOIN mention_entities x ON x.mention_id = m.id AND x.analysis_id = m.analysis_id
    JOIN mention_entities y ON y.mention_id = m.id AND y.analysis_id = m.analysis_id AND y.entity_id <> x.entity_id
    WHERE ${conds(p2, s, s.from, s.to, { skipEntity: true })} AND x.entity_id = ANY(${p2.add(focus)}::uuid[])
      ${s.q.entityId ? '' : `AND y.entity_id = ANY(${p2.add(focus)}::uuid[]) AND x.entity_id < y.entity_id`}
    GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 25`, p2.values)).rows : [];
  const extra = pairs.flatMap((r) => [r.a, r.b]).filter((id) => !meta.has(id));
  if (extra.length) for (const e of (await c.query(`SELECT id, display_name, entity_type FROM entities WHERE id = ANY($1::uuid[])`, [extra])).rows) meta.set(e.id, e);
  return {
    entities: rows.slice(0, s.q.limit ?? 25),
    emerging: emerging(rows),
    coOccurrence: pairs.map((r) => ({ a: { id: r.a, name: meta.get(r.a)?.display_name }, b: { id: r.b, name: meta.get(r.b)?.display_name }, articles: r.n })),
    definitions: {
      articles: 'Unique analysed articles mentioning the entity (after alias resolution) in their current analysis.',
      toneToward: 'Entity-targeted tone, only where the analysis method produced it; otherwise null.',
      coOccurrence: 'Unique articles mentioning both entities. Co-occurrence is not evidence of a relationship between them.',
    },
  };
}

// ── Issues widget ──────────────────────────────────────────────────────────────────────────────────

export async function issues(c: PoolClient, s: Scope, limit = 5) {
  const statuses = issueStatuses(s);
  const top = (await c.query(`SELECT i.id, i.title, i.status, i.severity, i.severity_points, i.subject_type, i.first_detected_at, i.last_detected_at, i.project_id, p.name AS project_name
    FROM detected_issues i JOIN projects p ON p.id = i.project_id
    WHERE i.project_id = ANY($1::uuid[]) AND i.status = ANY($2) AND i.last_detected_at >= $3 AND i.first_detected_at < $4
    ORDER BY i.severity_points DESC, i.last_detected_at DESC LIMIT $5`, [s.projects, statuses, s.from, s.to, limit])).rows;
  const counts = (await c.query(`SELECT severity, count(*)::int AS n FROM detected_issues WHERE project_id = ANY($1::uuid[]) AND status = ANY($2)
    AND last_detected_at >= $3 AND first_detected_at < $4 GROUP BY 1`, [s.projects, statuses, s.from, s.to])).rows;
  const by = Object.fromEntries(counts.map((r) => [r.severity, r.n]));
  return { statuses, top, bySeverity: by, highPriority: n(by.high) + n(by.critical),
    definition: 'Detected issues active during the period (first detected before its end and last detected after its start) in the chosen statuses.' };
}

// ── Cache ──────────────────────────────────────────────────────────────────────────────────────────

export interface Stamp { dataVersion: number; matched: string | null; discovered: string | null; analysed: string | null; aggregatesCurrent: boolean }

/** What the cached result depends on. A cache entry is valid only while the stamp is unchanged and it has not expired. */
export async function dataStamp(c: PoolClient): Promise<Stamp> {
  const r = (await c.query(`SELECT (SELECT data_version FROM analytics_state) AS v, (SELECT max(matched_at) FROM mention_matches) AS mat,
      (SELECT max(discovered_at) FROM mentions) AS disc, (SELECT max(finished_at) FROM mention_analyses) AS ana,
      (SELECT watermark_matched FROM analytics_state) AS wm, (SELECT watermark_discovered FROM analytics_state) AS wd, (SELECT watermark_analysed FROM analytics_state) AS wa`)).rows[0];
  const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
  const ge = (w: Date | null, x: Date | null) => !x || (!!w && new Date(w) >= new Date(x));
  return { dataVersion: Number(r.v ?? 0), matched: iso(r.mat), discovered: iso(r.disc), analysed: iso(r.ana),
    aggregatesCurrent: r.v != null && ge(r.wm, r.mat) && ge(r.wd, r.disc) && ge(r.wa, r.ana) };
}

export function cacheKey(metric: string, s: Scope): string {
  const q = { ...s.q }; delete q.from; delete q.to; delete q.days;
  const norm = JSON.stringify({ metric, q: Object.fromEntries(Object.entries(q).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b))),
    projects: [...s.projects].sort(), from: s.from.toISOString(), to: s.to.toISOString(), tz: s.tz, g: s.granularity });
  return createHash('sha256').update(norm).digest('hex');
}

/**
 * Serves a metric from `analytics_cache` when the entry was computed from the same data (stamp) and has not expired;
 * otherwise computes, stores and returns it. Freshness (collection, analysis, source health) is never cached: it is read on
 * every request. Every response states its period, freshness and whether it was cached.
 */
export async function cached<T extends object>(c: PoolClient, metric: string, s: Scope, o: EngineOptions, compute: () => Promise<T>) {
  const key = cacheKey(metric, s);
  const stamp = await dataStamp(c);
  const hit = (await c.query(`SELECT payload, computed_at, expires_at FROM analytics_cache WHERE cache_key = $1 AND data_version = $2 AND expires_at > $3`,
    [key, stamp.dataVersion, o.now])).rows[0];
  // Compared field by field: jsonb does not preserve key order, so serialised strings are not comparable.
  const same = (x: Partial<Stamp> | undefined) => !!x && (Object.keys(stamp) as Array<keyof Stamp>).every((k) => x[k] === stamp[k]);
  if (hit && same(hit.payload._stamp)) {
    const payload = { ...hit.payload }; delete payload._stamp;
    return { ...payload, freshness: await freshness(c, s, o), cache: { hit: true, computedAt: hit.computed_at, expiresAt: hit.expires_at, dataVersion: stamp.dataVersion } } as T & Envelope;
  }
  const body = {
    metric,
    period: { from: s.from.toISOString(), to: s.to.toISOString(), timezone: s.tz, granularity: s.granularity, days: Math.round(((s.to.getTime() - s.from.getTime()) / D) * 100) / 100,
      boundaries: 'Half-open [from, to). Buckets are calendar days/ISO weeks/months in the timezone shown.' },
    scope: { projects: s.projects.length, projectId: s.q.projectId ?? null },
    filters: Object.fromEntries(Object.entries(s.q).filter(([k, v]) => v !== undefined && !['from', 'to', 'days', 'limit', 'offset'].includes(k))),
    ...(await compute()),
  };
  const expires = new Date(o.now.getTime() + o.cacheTtlSeconds * 1000);
  await c.query(`INSERT INTO analytics_cache (tenant_id, cache_key, metric, data_version, payload, computed_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (tenant_id, cache_key) DO UPDATE SET data_version = EXCLUDED.data_version, payload = EXCLUDED.payload, computed_at = EXCLUDED.computed_at, expires_at = EXCLUDED.expires_at`,
    [s.viewer.tenantId, key, metric, stamp.dataVersion, JSON.stringify({ ...body, _stamp: stamp }), o.now, expires]);
  return { ...body, freshness: await freshness(c, s, o), cache: { hit: false, computedAt: o.now, expiresAt: expires, dataVersion: stamp.dataVersion } } as unknown as T & Envelope;
}
export interface Envelope { metric: string; period: { from: string; to: string; timezone: string; granularity: Granularity }; freshness: Awaited<ReturnType<typeof freshness>>; cache: { hit: boolean } }

export async function overview(c: PoolClient, s: Scope) {
  const cov = await coverage(c, s);
  const sen = await sentimentTotals(c, s, s.from, s.to);
  const sov = await shareOfVoiceMetric(c, { ...s, q: { ...s.q, entityIds: s.q.entityIds } });
  const top = await topics(c, s);
  const ents = await entities(c, { ...s, q: { ...s.q, limit: 8 } });
  const iss = await issues(c, s);
  return {
    coverage: { totals: cov.totals, change: cov.change, rolling: cov.rolling, timeline: cov.timeline },
    sentiment: sen,
    shareOfVoice: { group: sov.group, entities: sov.entities, denominator: sov.denominator, eligibleArticles: sov.eligibleArticles, autoSelected: sov.autoSelected, warnings: sov.warnings, formula: sov.formula },
    topIssues: iss,
    trendingTopics: top.emerging.slice(0, 5), topTopics: top.topics.slice(0, 8),
    entities: ents.entities,
    completeness: await completeness(c, s),
    definitions: cov.definitions,
  };
}

export { completeness };
