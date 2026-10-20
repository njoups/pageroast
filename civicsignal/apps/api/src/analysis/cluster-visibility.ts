import type { PoolClient } from 'pg';
import { seesAllProjects } from '../authz/permissions';
import type { AuthContext, TenantContext } from '../common/request';
import { mentionConditions, Params } from './filters';

export const RESTRICTED_LABEL = 'Related coverage (details restricted)';

/**
 * A story cluster's label is its representative record's headline, and that record may belong to a project the caller
 * cannot see. For restricted roles, the label is the representative's headline only when that record is visible to them,
 * otherwise the earliest visible member's headline, otherwise a neutral placeholder. Owners/admins see everything.
 */
export async function visibleClusterLabels(c: PoolClient, auth: AuthContext, t: TenantContext, clusterIds: string[]): Promise<Map<string, string> | null> {
  if (seesAllProjects(t.role) || clusterIds.length === 0) return null;
  const p = new Params();
  const w = mentionConditions(p, auth, t).join(' AND ');
  const rows = (await c.query<{ cluster_id: string; title: string; label: string; is_rep: boolean }>(
    `SELECT DISTINCT ON (cm.cluster_id) cm.cluster_id, m.title, sc.label, (m.id = sc.representative_mention_id) AS is_rep
     FROM cluster_members cm JOIN story_clusters sc ON sc.id = cm.cluster_id JOIN mentions m ON m.id = cm.mention_id
     WHERE cm.cluster_id = ANY(${p.add(clusterIds)}::uuid[]) AND cm.removed_at IS NULL AND ${w}
     ORDER BY cm.cluster_id, (m.id = sc.representative_mention_id) DESC, coalesce(m.published_at, m.discovered_at), m.id`, p.values)).rows;
  const out = new Map<string, string>(clusterIds.map((id) => [id, RESTRICTED_LABEL]));
  for (const r of rows) out.set(r.cluster_id, r.is_rep ? r.label : r.title);
  return out;
}

/** Applies visibleClusterLabels to rows carrying `id` and `label`. */
export async function withVisibleLabels<T extends { id: string; label: string }>(c: PoolClient, auth: AuthContext, t: TenantContext, rows: T[]): Promise<T[]> {
  const labels = await visibleClusterLabels(c, auth, t, rows.map((r) => r.id));
  return labels ? rows.map((r) => ({ ...r, label: labels.get(r.id) ?? RESTRICTED_LABEL })) : rows;
}
