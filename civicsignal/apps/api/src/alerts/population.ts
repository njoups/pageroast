import type { PoolClient } from 'pg';
import { MatchDocument, evaluate, parseQuery } from '../ingestion/query';
import type { Row } from './detection';
import type { RuleConfig } from './rule-config';

const T = 'coalesce(m.published_at, m.discovered_at)';
export const POPULATION_LIMIT = 50_000;

/**
 * Original (non-duplicate) records matched to the project in [from, to], narrowed by the rule's filters. Keyword
 * expressions are evaluated in memory with the bounded query parser (never turned into SQL).
 */
export async function loadPopulation(c: PoolClient, projectId: string, f: RuleConfig['filters'], from: number, to: number): Promise<{ rows: Row[]; capped: boolean }> {
  const params: unknown[] = [projectId, new Date(from), new Date(to)];
  const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
  const where = [`m.duplicate_status = 'original'`, `${T} > $2`, `${T} <= $3`,
    `EXISTS (SELECT 1 FROM mention_matches mm WHERE mm.mention_id = m.id AND mm.project_id = $1)`];
  if (f.sourceIds.length) where.push(`m.source_id = ANY(${add(f.sourceIds)}::uuid[])`);
  if (f.entityIds.length) where.push(`EXISTS (SELECT 1 FROM mention_entities me WHERE me.mention_id = m.id AND me.analysis_id = m.analysis_id AND me.entity_id = ANY(${add(f.entityIds)}::uuid[]))`);
  if (f.topics.length) where.push(`EXISTS (SELECT 1 FROM mention_topics mt WHERE mt.mention_id = m.id AND mt.analysis_id = m.analysis_id AND mt.topic_key = ANY(${add(f.topics)}::text[]))`);
  const r = await c.query<{ id: string; t: string; publisher_domain: string; source_id: string; cluster_id: string | null; title: string; excerpt: string | null;
    headline_only: boolean; analysed: boolean; label: Row['label']; uncertain: boolean | null; is_syndicated: boolean | null; topics: string[] | null }>(
    `SELECT m.id, (extract(epoch FROM ${T}) * 1000)::bigint AS t, m.publisher_domain, m.source_id, cm.cluster_id, m.title, m.excerpt,
       (m.body IS NULL AND coalesce(length(m.excerpt), 0) < 60) AS headline_only, (m.analysis_id IS NOT NULL) AS analysed,
       sr.label, sr.uncertain, cm.is_syndicated,
       (SELECT array_agg(mt.topic_key) FROM mention_topics mt WHERE mt.analysis_id = m.analysis_id) AS topics
     FROM mentions m
     LEFT JOIN sentiment_results sr ON sr.analysis_id = m.analysis_id AND sr.target_type = 'article'
     LEFT JOIN cluster_members cm ON cm.mention_id = m.id AND cm.removed_at IS NULL
     WHERE ${where.join(' AND ')} ORDER BY ${T} DESC LIMIT ${POPULATION_LIMIT + 1}`, params);
  const capped = r.rows.length > POPULATION_LIMIT;
  const expr = f.keywords ? parseQuery(f.keywords) : null;
  const rows: Row[] = [];
  for (const x of r.rows.slice(0, POPULATION_LIMIT)) {
    if (expr && !evaluate(expr, new MatchDocument(`${x.title}\n${x.excerpt ?? ''}`))) continue;
    rows.push({ id: x.id, t: Number(x.t), publisher: x.publisher_domain, sourceId: x.source_id, clusterId: x.cluster_id, syndicated: !!x.is_syndicated,
      analysed: x.analysed && !!x.label, label: x.label, uncertain: x.uncertain ?? true, topics: x.topics ?? [], headlineOnly: x.headline_only });
  }
  return { rows, capped };
}

/**
 * Times of successful collection runs (for the given sources, or all), used to tell "no coverage happened" from
 * "collection was not running". A window counts as covered when a run succeeded inside it or within `graceMs` after it
 * (records published in a window are often collected a little later).
 */
export async function loadCoverage(c: PoolClient, sourceIds: string[], from: number, to: number) {
  const r = await c.query<{ t: string }>(
    `SELECT (extract(epoch FROM finished_at) * 1000)::bigint AS t FROM connector_runs
     WHERE status = 'succeeded' AND finished_at > $1 AND finished_at <= $2 ${sourceIds.length ? 'AND source_id = ANY($3::uuid[])' : ''} ORDER BY finished_at`,
    sourceIds.length ? [new Date(from), new Date(to), sourceIds] : [new Date(from), new Date(to)]);
  const times = r.rows.map((x) => Number(x.t));
  const latest = (await c.query<{ t: string | null }>(
    `SELECT (extract(epoch FROM max(finished_at)) * 1000)::bigint AS t FROM connector_runs WHERE status = 'succeeded' ${sourceIds.length ? 'AND source_id = ANY($1::uuid[])' : ''}`,
    sourceIds.length ? [sourceIds] : [])).rows[0]?.t;
  return { times, latestSuccess: latest ? Number(latest) : null };
}

export const coverageFn = (times: number[], graceMs: number) => (from: number, to: number) => times.some((t) => t > from && t <= to + graceMs);

/** Recomputes hourly and daily aggregates for one tenant over a recent range (idempotent upsert). */
export async function refreshActivity(c: PoolClient, tenantId: string, from: Date, to: Date): Promise<void> {
  await c.query(`DELETE FROM activity_hourly WHERE hour >= date_trunc('hour', $1::timestamptz) AND hour <= $2`, [from, to]);
  await c.query(
    `INSERT INTO activity_hourly (tenant_id, project_id, hour, mentions, publishers, analysed, positive, negative, neutral, mixed, uncertain)
     SELECT $1, mm.project_id, date_trunc('hour', ${T}), count(DISTINCT m.id), count(DISTINCT m.publisher_domain),
       count(DISTINCT m.id) FILTER (WHERE sr.label IS NOT NULL),
       count(DISTINCT m.id) FILTER (WHERE sr.label = 'positive' AND NOT sr.uncertain), count(DISTINCT m.id) FILTER (WHERE sr.label = 'negative' AND NOT sr.uncertain),
       count(DISTINCT m.id) FILTER (WHERE sr.label = 'neutral' AND NOT sr.uncertain), count(DISTINCT m.id) FILTER (WHERE sr.label = 'mixed' AND NOT sr.uncertain),
       count(DISTINCT m.id) FILTER (WHERE sr.uncertain)
     FROM mentions m JOIN mention_matches mm ON mm.mention_id = m.id
     LEFT JOIN sentiment_results sr ON sr.analysis_id = m.analysis_id AND sr.target_type = 'article'
     WHERE m.duplicate_status = 'original' AND ${T} >= date_trunc('hour', $2::timestamptz) AND ${T} <= $3
     GROUP BY mm.project_id, date_trunc('hour', ${T})`, [tenantId, from, to]);
  await c.query(`DELETE FROM topic_activity_daily WHERE day >= ($1::timestamptz AT TIME ZONE 'UTC')::date AND day <= ($2::timestamptz AT TIME ZONE 'UTC')::date`, [from, to]);
  await c.query(
    `INSERT INTO topic_activity_daily (tenant_id, project_id, day, topic_key, mentions, publishers)
     SELECT $1, mm.project_id, (${T} AT TIME ZONE 'UTC')::date, mt.topic_key, count(DISTINCT m.id), count(DISTINCT m.publisher_domain)
     FROM mentions m JOIN mention_matches mm ON mm.mention_id = m.id JOIN mention_topics mt ON mt.mention_id = m.id AND mt.analysis_id = m.analysis_id
     WHERE m.duplicate_status = 'original' AND ${T} >= (($2::timestamptz AT TIME ZONE 'UTC')::date)::timestamp AT TIME ZONE 'UTC' AND ${T} <= $3
     GROUP BY mm.project_id, (${T} AT TIME ZONE 'UTC')::date, mt.topic_key`, [tenantId, from, to]);
}
