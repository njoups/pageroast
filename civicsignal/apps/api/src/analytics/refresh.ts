import type { PoolClient } from 'pg';

const T = 'coalesce(m.published_at, m.discovered_at)';
const LANG = `lower(split_part(coalesce(m.detected_language, m.language, 'und'), '-', 1))`;
const MAX_HOURS_PER_PASS = 5000;

/**
 * Incremental refresh of `analytics_hourly` for one tenant (run inside its RLS context).
 * Affected hours are found from three watermarks: newly collected records, newly finished analyses (re-analysis changes
 * tone), and new project matches (query edits). Those hours are recomputed completely (delete + insert), so the result is
 * the same as a full rebuild for them. Removed matches and deletions are caught by a full rebuild once a day.
 * Returns whether anything changed; the tenant's data_version is bumped when it did.
 */
export async function refreshAnalytics(c: PoolClient, tenantId: string, now: Date, opts: { full?: boolean } = {}): Promise<{ changed: boolean; hours: number; full: boolean }> {
  await c.query(`INSERT INTO analytics_state (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING`, [tenantId]);
  const s = (await c.query<{ data_version: string; watermark_discovered: Date | null; watermark_analysed: Date | null; watermark_matched: Date | null; full_rebuild_at: Date | null }>(
    'SELECT * FROM analytics_state WHERE tenant_id = $1 FOR UPDATE', [tenantId])).rows[0]!;
  const full = opts.full || !s.full_rebuild_at || now.getTime() - s.full_rebuild_at.getTime() > 24 * 3_600_000;
  const marks = (await c.query<{ disc: Date | null; ana: Date | null; mat: Date | null }>(
    `SELECT (SELECT max(discovered_at) FROM mentions) AS disc, (SELECT max(finished_at) FROM mention_analyses) AS ana, (SELECT max(matched_at) FROM mention_matches) AS mat`)).rows[0]!;
  let hours: Date[];
  if (full) {
    hours = (await c.query<{ h: Date }>(`SELECT DISTINCT date_trunc('hour', ${T}) AS h FROM mentions m
      UNION SELECT DISTINCT hour FROM analytics_hourly`)).rows.map((r) => r.h);
  } else {
    hours = (await c.query<{ h: Date }>(
      `SELECT DISTINCT date_trunc('hour', ${T}) AS h FROM mentions m WHERE m.discovered_at > coalesce($1::timestamptz, '-infinity')
       UNION SELECT DISTINCT date_trunc('hour', ${T}) FROM mentions m JOIN mention_analyses a ON a.mention_id = m.id WHERE a.finished_at > coalesce($2::timestamptz, '-infinity')
       UNION SELECT DISTINCT date_trunc('hour', ${T}) FROM mentions m JOIN mention_matches mm ON mm.mention_id = m.id WHERE mm.matched_at > coalesce($3::timestamptz, '-infinity')
       LIMIT ${MAX_HOURS_PER_PASS}`, [s.watermark_discovered, s.watermark_analysed, s.watermark_matched])).rows.map((r) => r.h);
  }
  if (hours.length) {
    for (let i = 0; i < hours.length; i += 1000) {
      const batch = hours.slice(i, i + 1000);
      await c.query('DELETE FROM analytics_hourly WHERE hour = ANY($1::timestamptz[])', [batch]);
      await c.query(
        `INSERT INTO analytics_hourly (tenant_id, project_id, hour, source_id, language, sentiment, uncertain, articles, records)
         SELECT $1::uuid, mm.project_id, date_trunc('hour', ${T}), m.source_id, ${LANG},
           CASE WHEN m.analysis_id IS NULL THEN 'unanalysed' ELSE coalesce(sr.label, 'unknown') END, coalesce(sr.uncertain, false),
           count(DISTINCT m.id) FILTER (WHERE m.duplicate_status = 'original'), count(DISTINCT m.id)
         FROM mentions m JOIN mention_matches mm ON mm.mention_id = m.id
         LEFT JOIN sentiment_results sr ON sr.analysis_id = m.analysis_id AND sr.target_type = 'article'
         WHERE date_trunc('hour', ${T}) = ANY($2::timestamptz[])
         GROUP BY 1, 2, 3, 4, 5, 6, 7`, [tenantId, batch]);
    }
  }
  // When the hour list was truncated, keep the old watermarks so the remainder is picked up next pass.
  const truncated = !full && hours.length >= MAX_HOURS_PER_PASS;
  await c.query(
    `UPDATE analytics_state SET data_version = data_version + CASE WHEN $2 THEN 1 ELSE 0 END, refreshed_at = $3, last_refresh_hours = $4,
       watermark_discovered = CASE WHEN $5 THEN watermark_discovered ELSE $6 END, watermark_analysed = CASE WHEN $5 THEN watermark_analysed ELSE $7 END,
       watermark_matched = CASE WHEN $5 THEN watermark_matched ELSE $8 END, full_rebuild_at = CASE WHEN $9 THEN $3 ELSE full_rebuild_at END
     WHERE tenant_id = $1`, [tenantId, hours.length > 0, now, hours.length, truncated, marks.disc, marks.ana, marks.mat, full]);
  return { changed: hours.length > 0, hours: hours.length, full };
}
