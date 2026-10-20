import type { PoolClient } from 'pg';

/**
 * Removes records and everything derived from them, inside the caller's tenant transaction:
 *  - report files that cite any of the records are expired (their bytes deleted; run metadata kept, marked);
 *  - generated summaries citing them are deleted; issue summaries built from them are cleared;
 *  - the records are deleted, which cascades to matches, analyses, entities, topics, tone, cluster membership,
 *    alert evidence and report citations (foreign keys); the full-text index lives in the row and goes with it;
 *  - cluster counters are recomputed; analytics aggregates are scheduled for a full rebuild and the cache is purged.
 * Returns per-table counts. Callers record the audit event.
 */
export async function purgeMentions(c: PoolClient, ids: string[], now: Date, reason: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  if (!ids.length) return { mentions: 0 };
  const n = async (sql: string, values: unknown[]) => (await c.query(sql, values)).rowCount ?? 0;
  out.report_artifacts_expired = await n(`UPDATE report_artifacts a SET data = NULL, expired_at = $2
    WHERE a.data IS NOT NULL AND EXISTS (SELECT 1 FROM report_run_sources s WHERE s.run_id = a.run_id AND s.mention_id = ANY($1::uuid[]))`, [ids, now]);
  await c.query(`UPDATE report_runs r SET limitations = array_append(r.limitations, $2)
    WHERE EXISTS (SELECT 1 FROM report_run_sources s WHERE s.run_id = r.id AND s.mention_id = ANY($1::uuid[]))`, [ids, `Files removed on ${now.toISOString().slice(0, 10)}: cited records were deleted (${reason}).`]);
  out.ai_summaries = await n(`DELETE FROM ai_summaries WHERE supporting_mention_ids && $1::uuid[] OR mention_id = ANY($1::uuid[])`, [ids]);
  out.issue_summaries_cleared = await n(`UPDATE detected_issues i SET ai_summary = NULL
    WHERE i.ai_summary IS NOT NULL AND EXISTS (SELECT 1 FROM alert_evidence e WHERE e.issue_id = i.id AND e.mention_id = ANY($1::uuid[]))`, [ids]);
  const clusters = (await c.query<{ cluster_id: string }>(`SELECT DISTINCT cluster_id FROM cluster_members WHERE mention_id = ANY($1::uuid[])`, [ids])).rows.map((r) => r.cluster_id);
  for (const [k, sql] of Object.entries({
    mention_matches: 'SELECT count(*)::int AS n FROM mention_matches WHERE mention_id = ANY($1::uuid[])',
    mention_analyses: 'SELECT count(*)::int AS n FROM mention_analyses WHERE mention_id = ANY($1::uuid[])',
    alert_evidence: 'SELECT count(*)::int AS n FROM alert_evidence WHERE mention_id = ANY($1::uuid[])',
    report_citations: 'SELECT count(*)::int AS n FROM report_run_sources WHERE mention_id = ANY($1::uuid[])',
  })) out[k] = (await c.query<{ n: number }>(sql, [ids])).rows[0]!.n;
  out.mentions = await n('DELETE FROM mentions WHERE id = ANY($1::uuid[])', [ids]);
  if (clusters.length) {
    await c.query(`UPDATE story_clusters sc SET member_count = x.n, updated_at = $2,
        representative_mention_id = CASE WHEN sc.representative_mention_id = ANY($3::uuid[]) THEN NULL ELSE sc.representative_mention_id END
      FROM (SELECT c.id, (SELECT count(*)::int FROM cluster_members cm WHERE cm.cluster_id = c.id AND cm.removed_at IS NULL) AS n FROM story_clusters c WHERE c.id = ANY($1::uuid[])) x
      WHERE sc.id = x.id`, [clusters, now, ids]);
    await c.query(`UPDATE story_clusters SET status = 'dissolved', updated_at = $2 WHERE id = ANY($1::uuid[]) AND member_count = 0 AND status = 'active'`, [clusters, now]);
  }
  out.clusters_updated = clusters.length;
  await invalidateAnalytics(c);
  return out;
}

/** Forces the next aggregation pass to rebuild everything and drops cached analytics (explicit invalidation). */
export async function invalidateAnalytics(c: PoolClient) {
  await c.query(`UPDATE analytics_state SET full_rebuild_at = NULL, data_version = data_version + 1`);
  await c.query('DELETE FROM analytics_cache');
}
