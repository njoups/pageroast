import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AppConfig, CONFIG } from '../config';
import { CLUSTER_METHOD, decide, representative, type ClusterDoc } from './clustering';
import { SummariesService } from './summaries.service';
import { significantTokens } from './text';

interface Row { id: string; title: string; publisher_domain: string; content_hash: string; t: Date; cluster_id: string | null }

/**
 * Related-story clustering. Records are never merged or deleted: clusters are memberships with scores, reasons and an
 * append-only event log, so every change (create, join, leave, merge, relabel) is traceable.
 */
@Injectable()
export class ClusterService {
  constructor(@Inject(CONFIG) private readonly config: AppConfig, private readonly summaries: SummariesService) {}

  private async docs(c: PoolClient, rows: Row[]): Promise<Map<string, ClusterDoc & { clusterId: string | null }>> {
    const ids = rows.map((r) => r.id);
    const ents = ids.length ? (await c.query<{ mention_id: string; entity_id: string }>(
      `SELECT me.mention_id, me.entity_id FROM mention_entities me JOIN mentions m ON m.id = me.mention_id AND me.analysis_id = m.analysis_id
       WHERE me.mention_id = ANY($1::uuid[]) AND me.entity_id IS NOT NULL`, [ids])).rows : [];
    const tops = ids.length ? (await c.query<{ mention_id: string; topic_key: string }>(
      `SELECT mt.mention_id, mt.topic_key FROM mention_topics mt JOIN mentions m ON m.id = mt.mention_id AND mt.analysis_id = m.analysis_id
       WHERE mt.mention_id = ANY($1::uuid[]) AND mt.topic_key NOT IN ('unknown','other')`, [ids])).rows : [];
    const out = new Map<string, ClusterDoc & { clusterId: string | null }>();
    for (const r of rows) {
      out.set(r.id, { id: r.id, publisherDomain: r.publisher_domain, contentHash: r.content_hash, time: r.t.getTime(), tokens: new Set(significantTokens(r.title)),
        entities: new Set(ents.filter((e) => e.mention_id === r.id).map((e) => e.entity_id)), topics: new Set(tops.filter((t) => t.mention_id === r.id).map((t) => t.topic_key)), clusterId: r.cluster_id });
    }
    return out;
  }

  private async event(c: PoolClient, tenantId: string, clusterId: string, event: string, mentionId: string | null, details: Record<string, unknown> = {}) {
    await c.query('INSERT INTO cluster_events (tenant_id, cluster_id, event, mention_id, details) VALUES ($1,$2,$3,$4,$5)', [tenantId, clusterId, event, mentionId, JSON.stringify(details)]);
  }

  private async addMember(c: PoolClient, tenantId: string, clusterId: string, mentionId: string, score: number, reasons: unknown, syndicatedHint: boolean) {
    const syn = syndicatedHint || (await c.query(
      `SELECT 1 FROM cluster_members cm JOIN mentions o ON o.id = cm.mention_id JOIN mentions m ON m.id = $2
       WHERE cm.cluster_id = $1 AND cm.removed_at IS NULL AND o.content_hash = m.content_hash AND o.publisher_domain <> m.publisher_domain`, [clusterId, mentionId])).rowCount! > 0;
    await c.query('INSERT INTO cluster_members (tenant_id, cluster_id, mention_id, score, reasons, is_syndicated) VALUES ($1,$2,$3,$4,$5,$6)',
      [tenantId, clusterId, mentionId, score, JSON.stringify(reasons), syn]);
    await c.query('UPDATE mentions SET cluster_id = $2 WHERE id = $1', [mentionId, clusterId]);
    await this.event(c, tenantId, clusterId, 'member_added', mentionId, { score, syndicated: syn });
  }

  /** Removes a mention's active membership (e.g. before reprocessing). */
  async detach(c: PoolClient, tenantId: string, mentionId: string): Promise<string | null> {
    const r = await c.query<{ cluster_id: string }>('UPDATE cluster_members SET removed_at = now() WHERE mention_id = $1 AND removed_at IS NULL RETURNING cluster_id', [mentionId]);
    await c.query('UPDATE mentions SET cluster_id = NULL WHERE id = $1', [mentionId]);
    const cid = r.rows[0]?.cluster_id ?? null;
    if (cid) { await this.event(c, tenantId, cid, 'member_removed', mentionId, { reason: 'reprocessing' }); await this.recompute(c, tenantId, cid); }
    return cid;
  }

  /** Recomputes label, representative and statistics; dissolves clusters left with fewer than two members. */
  async recompute(c: PoolClient, tenantId: string, clusterId: string): Promise<number | null> {
    const rows = (await c.query<Row & { score: string; is_syndicated: boolean; title_prev: string }>(
      `SELECT m.id, m.title, m.publisher_domain, m.content_hash, coalesce(m.published_at, m.discovered_at) AS t, cm.cluster_id, cm.score, cm.is_syndicated
       FROM cluster_members cm JOIN mentions m ON m.id = cm.mention_id WHERE cm.cluster_id = $1 AND cm.removed_at IS NULL`, [clusterId])).rows;
    const prev = (await c.query<{ label: string }>('SELECT label FROM story_clusters WHERE id = $1', [clusterId])).rows[0];
    if (rows.length < 2) {
      for (const r of rows) {
        await c.query('UPDATE cluster_members SET removed_at = now() WHERE cluster_id = $1 AND mention_id = $2 AND removed_at IS NULL', [clusterId, r.id]);
        await c.query('UPDATE mentions SET cluster_id = NULL WHERE id = $1', [r.id]);
        await this.event(c, tenantId, clusterId, 'member_removed', r.id, { reason: 'cluster_dissolved' });
      }
      await c.query(`UPDATE story_clusters SET status = 'dissolved', member_count = 0, version = version + 1, updated_at = now() WHERE id = $1`, [clusterId]);
      return null;
    }
    const docs = await this.docs(c, rows);
    const rep = representative([...docs.values()], this.config.ai.clusterWindowHours);
    const repRow = rows.find((r) => r.id === rep.id)!;
    const times = rows.map((r) => r.t.getTime());
    const v = (await c.query<{ version: number }>(
      `UPDATE story_clusters SET label = $2, representative_mention_id = $3, member_count = $4, independent_count = $5, publisher_count = $6,
         first_seen_at = $7, last_seen_at = $8, confidence = $9, method_version = $10, status = 'active', version = version + 1, updated_at = now()
       WHERE id = $1 RETURNING version`,
      [clusterId, repRow.title, rep.id, rows.length, // Independent = distinct publishers among non-syndicated records (follow-ups by one outlet are not corroboration).
        new Set(rows.filter((r) => !r.is_syndicated).map((r) => r.publisher_domain)).size, new Set(rows.map((r) => r.publisher_domain)).size,
        new Date(Math.min(...times)), new Date(Math.max(...times)), Math.round((rows.reduce((n, r) => n + Number(r.score), 0) / rows.length) * 1000) / 1000, CLUSTER_METHOD])).rows[0]!.version;
    if (prev && prev.label !== repRow.title) await this.event(c, tenantId, clusterId, 'relabelled', rep.id, { from: prev.label, to: repRow.title });
    await this.summaries.extractiveCluster(c, tenantId, clusterId);
    return v;
  }

  /** Assigns a freshly analysed mention to a cluster (or none). Returns the affected cluster and its new version. */
  /**
   * Serialises cluster changes within a tenant for the rest of the transaction. Concurrent workers otherwise race:
   * one record's assignment can add another record as a member while that record's own analysis re-assigns it.
   */
  async lock(c: PoolClient, tenantId: string): Promise<void> {
    await c.query(`SELECT pg_advisory_xact_lock(hashtextextended('civicsignal:cluster:' || $1::text, 0))`, [tenantId]);
  }

  async assign(c: PoolClient, tenantId: string, mentionId: string): Promise<{ clusterId: string | null; version: number | null; action: string }> {
    const w = this.config.ai.clusterWindowHours;
    const target = (await c.query<Row>(
      `SELECT id, title, publisher_domain, content_hash, coalesce(published_at, discovered_at) AS t, NULL::uuid AS cluster_id FROM mentions WHERE id = $1 AND duplicate_status = 'original'`, [mentionId])).rows[0];
    if (!target) return { clusterId: null, version: null, action: 'none' };
    const cands = (await c.query<Row>(
      `SELECT m.id, m.title, m.publisher_domain, m.content_hash, coalesce(m.published_at, m.discovered_at) AS t, cm.cluster_id
       FROM mentions m LEFT JOIN cluster_members cm ON cm.mention_id = m.id AND cm.removed_at IS NULL
       WHERE m.id <> $1 AND m.duplicate_status = 'original' AND m.analysis_id IS NOT NULL
         AND coalesce(m.published_at, m.discovered_at) BETWEEN $2::timestamptz - make_interval(hours => $3) AND $2::timestamptz + make_interval(hours => $3)
       ORDER BY abs(extract(epoch FROM coalesce(m.published_at, m.discovered_at) - $2::timestamptz)) LIMIT 400`, [mentionId, target.t, w])).rows;
    const docs = await this.docs(c, [target, ...cands]);
    const me = docs.get(mentionId)!;
    const decision = decide(me, cands.map((r) => ({ doc: docs.get(r.id)!, clusterId: r.cluster_id })), this.config.ai.clusterThreshold, w);
    if (decision.action === 'none') return { clusterId: null, version: null, action: 'none' };
    if (decision.action === 'create') {
      const id = (await c.query<{ id: string }>(
        `INSERT INTO story_clusters (tenant_id, label, method_version, first_seen_at, last_seen_at) VALUES ($1,$2,$3, now(), now()) RETURNING id`,
        [tenantId, target.title, CLUSTER_METHOD])).rows[0]!.id;
      await this.event(c, tenantId, id, 'created', mentionId, { score: decision.score, reasons: decision.pair.reasons });
      await this.addMember(c, tenantId, id, decision.withId, decision.score, decision.pair.reasons, false);
      await this.addMember(c, tenantId, id, mentionId, decision.score, decision.pair.reasons, decision.pair.syndicated);
      return { clusterId: id, version: await this.recompute(c, tenantId, id), action: 'create' };
    }
    for (const mergeId of decision.mergeClusterIds) {
      const moved = (await c.query<{ mention_id: string; score: string; reasons: unknown; is_syndicated: boolean }>(
        'UPDATE cluster_members SET removed_at = now() WHERE cluster_id = $1 AND removed_at IS NULL RETURNING mention_id, score, reasons, is_syndicated', [mergeId])).rows;
      for (const m of moved) {
        await c.query('INSERT INTO cluster_members (tenant_id, cluster_id, mention_id, score, reasons, is_syndicated) VALUES ($1,$2,$3,$4,$5,$6)',
          [tenantId, decision.clusterId, m.mention_id, m.score, JSON.stringify({ mergedFrom: mergeId, previous: m.reasons }), m.is_syndicated]);
        await c.query('UPDATE mentions SET cluster_id = $2 WHERE id = $1', [m.mention_id, decision.clusterId]);
      }
      await c.query(`UPDATE story_clusters SET status = 'merged', merged_into = $2, member_count = 0, version = version + 1, updated_at = now() WHERE id = $1`, [mergeId, decision.clusterId]);
      await this.event(c, tenantId, mergeId, 'merged_into', mentionId, { into: decision.clusterId, members: moved.length });
      await this.event(c, tenantId, decision.clusterId, 'absorbed', mentionId, { from: mergeId, members: moved.length });
    }
    await this.addMember(c, tenantId, decision.clusterId, mentionId, decision.score, decision.pair.reasons, decision.pair.syndicated);
    return { clusterId: decision.clusterId, version: await this.recompute(c, tenantId, decision.clusterId), action: decision.mergeClusterIds.length ? 'merge' : 'join' };
  }
}
