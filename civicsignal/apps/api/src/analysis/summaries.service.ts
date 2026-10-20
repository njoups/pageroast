import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { Database } from '../database/database.service';
import { logEvent } from '../ingestion/log';
import { ANALYSIS_PROVIDER } from './providers';
import type { AnalysisProvider } from './providers/provider';
import { sanitizeMultiSummary } from './schemas';
import { topicLabel } from './taxonomy';
import { quotaState, recordAiUsage } from './usage';

const SYS = '00000000-0000-0000-0000-000000000000';

interface Claim { text: string; kind: 'source_fact' | 'interpretation' | 'data'; supportingMentionIds: string[]; quote?: string | null }

async function setCurrent(c: PoolClient, where: string, params: unknown[], id: string) {
  await c.query(`UPDATE ai_summaries SET is_current = false WHERE is_current AND ${where} AND id <> $${params.length + 1}`, [...params, id]);
}

/**
 * Summaries are either extractive (quoting stored records and counts; always available) or LLM-generated with every
 * claim linked to records. LLM claims citing records outside the supplied set are discarded (sanitizeMultiSummary).
 */
@Injectable()
export class SummariesService {
  constructor(private readonly db: Database, @Inject(ANALYSIS_PROVIDER) private readonly provider: AnalysisProvider) {}

  get generative(): boolean { return this.provider.method !== 'baseline'; }

  /** Extractive cluster summary: counts and member headlines, each linked to its record. Runs inside the caller's tx. */
  async extractiveCluster(c: PoolClient, tenantId: string, clusterId: string): Promise<void> {
    const members = (await c.query<{ id: string; title: string; publisher: string | null; publisher_domain: string; t: Date; is_syndicated: boolean }>(
      `SELECT m.id, m.title, m.publisher, m.publisher_domain, coalesce(m.published_at, m.discovered_at) AS t, cm.is_syndicated
       FROM cluster_members cm JOIN mentions m ON m.id = cm.mention_id WHERE cm.cluster_id = $1 AND cm.removed_at IS NULL ORDER BY t`, [clusterId])).rows;
    if (members.length < 2) return;
    const publishers = new Set(members.map((m) => m.publisher_domain)).size;
    const syndicated = members.filter((m) => m.is_syndicated).length;
    const fmt = (d: Date) => d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
    const claims: Claim[] = [
      { kind: 'data', text: `${members.length} reports from ${publishers} publisher${publishers > 1 ? 's' : ''} between ${fmt(members[0]!.t)} and ${fmt(members.at(-1)!.t)}${syndicated ? `; ${syndicated} ${syndicated > 1 ? 'are syndicated copies' : 'is a syndicated copy'} of another report` : ''}.`, supportingMentionIds: members.map((m) => m.id) },
      ...members.slice(0, 8).map((m) => ({ kind: 'source_fact' as const, text: `${m.publisher ?? m.publisher_domain}: “${m.title}”`, quote: m.title, supportingMentionIds: [m.id] })),
    ];
    const notes = ['Grouped automatically by headline, entity and topic similarity; membership may change as more coverage arrives.',
      ...(syndicated ? ['Syndicated copies repeat the same wire text and are not independent corroboration.'] : [])];
    const r = await c.query<{ id: string }>(
      `INSERT INTO ai_summaries (tenant_id, scope, cluster_id, status, summary_text, claims, uncertainty_notes, supporting_mention_ids, method, provider, model, prompt_version, generated_at, is_current)
       VALUES ($1,'cluster',$2,'ready',NULL,$3,$4,$5,'extractive','baseline','civicsignal-baseline','extractive-cluster@1', now(), true) RETURNING id`,
      [tenantId, clusterId, JSON.stringify(claims), notes, members.map((m) => m.id)]);
    await setCurrent(c, 'scope = \'cluster\' AND cluster_id = $1', [clusterId], r.rows[0]!.id);
  }

  /** LLM cluster summary for a specific cluster version (stale jobs are ignored). */
  async generateClusterSummary(tenantId: string, clusterId: string, version: number): Promise<'done' | 'stale' | 'insufficient' | 'quota'> {
    const data = await this.db.withTenant(tenantId, SYS, async (c) => {
      const cl = (await c.query<{ version: number; status: string }>('SELECT version, status FROM story_clusters WHERE id = $1', [clusterId])).rows[0];
      if (!cl || cl.version !== version || cl.status !== 'active') return null;
      const records = (await c.query<{ id: string; title: string; excerpt: string | null; publisher: string | null; publisher_domain: string; published_at: Date | null; is_syndicated: boolean }>(
        `SELECT m.id, m.title, m.excerpt, m.publisher, m.publisher_domain, m.published_at, cm.is_syndicated FROM cluster_members cm JOIN mentions m ON m.id = cm.mention_id
         WHERE cm.cluster_id = $1 AND cm.removed_at IS NULL ORDER BY coalesce(m.published_at, m.discovered_at) LIMIT 20`, [clusterId])).rows;
      return records;
    });
    if (!data) return 'stale';
    const quota = await this.db.withTenant(tenantId, SYS, (c) => quotaState(c));
    if (quota.tokensThisMonth >= quota.monthlyTokenLimit) { logEvent('info', 'analysis.summary_quota_reached', { tenantId, clusterId }); return 'quota'; }
    const refs = new Map(data.map((r, i) => [`R${i + 1}`, r.id]));
    const res = await this.provider.summarize({
      scope: 'cluster', language: 'id',
      records: data.map((r, i) => ({ ref: `R${i + 1}`, publisher: r.publisher ?? r.publisher_domain, published: r.published_at?.toISOString() ?? null, title: r.title, excerpt: r.excerpt, syndicated: r.is_syndicated })),
    });
    if (!res) return 'insufficient';
    const s = sanitizeMultiSummary(res.output, refs);
    return this.db.withTenant(tenantId, SYS, async (c) => {
      const ins = await c.query<{ id: string }>(
        `INSERT INTO ai_summaries (tenant_id, scope, cluster_id, status, summary_text, claims, conflicts, uncertainty_notes, supporting_mention_ids, method, provider, model, prompt_version, tokens_in, tokens_out, generated_at, is_current)
         VALUES ($1,'cluster',$2,$3,$4,$5,$6,$7,$8,'llm',$9,$10,$11,$12,$13, now(), $14) RETURNING id`,
        [tenantId, clusterId, s.status === 'ok' ? 'ready' : 'insufficient_evidence', s.headline, JSON.stringify(s.claims), JSON.stringify(s.conflicts), s.uncertainty,
          [...new Set(s.claims.flatMap((x) => x.supportingMentionIds))], this.provider.name, res.model, res.promptVersion, res.usage.inputTokens, res.usage.outputTokens, s.status === 'ok']);
      const id = ins.rows[0]!.id;
      const { cost } = await recordAiUsage(c, tenantId, this.provider.name, res.model, 'cluster-summary', res.usage, { summaryId: id });
      await c.query('UPDATE ai_summaries SET cost_estimate = $2 WHERE id = $1', [id, cost]);
      if (s.status === 'ok') await setCurrent(c, 'scope = \'cluster\' AND cluster_id = $1', [clusterId], id);
      return s.status === 'ok' ? 'done' : 'insufficient';
    });
  }

  /** Project or period summary (queued row → generated here). */
  async generateProjectSummary(tenantId: string, summaryId: string): Promise<void> {
    const ctx = await this.db.withTenant(tenantId, SYS, async (c) => {
      const s = (await c.query<{ id: string; project_id: string; scope: string; period_start: Date | null; period_end: Date | null; status: string }>(
        'SELECT id, project_id, scope, period_start, period_end, status FROM ai_summaries WHERE id = $1', [summaryId])).rows[0];
      if (!s || s.status !== 'queued') return null;
      const from = s.period_start ?? new Date(Date.now() - 7 * 86400_000); const to = s.period_end ?? new Date();
      const base = `FROM mentions m JOIN mention_matches mm ON mm.mention_id = m.id AND mm.project_id = $1
        WHERE m.duplicate_status = 'original' AND coalesce(m.published_at, m.discovered_at) BETWEEN $2 AND $3`;
      const total = (await c.query<{ n: number }>(`SELECT count(DISTINCT m.id)::int AS n ${base}`, [s.project_id, from, to])).rows[0]!.n;
      const sentiment = (await c.query<{ label: string; n: number }>(
        `SELECT sr.label, count(DISTINCT m.id)::int AS n ${base.replace('WHERE', 'JOIN sentiment_results sr ON sr.mention_id = m.id AND sr.analysis_id = m.analysis_id AND sr.target_type = \'article\' WHERE')} GROUP BY sr.label`,
        [s.project_id, from, to])).rows;
      const topics = (await c.query<{ topic_key: string; n: number }>(
        `SELECT mt.topic_key, count(DISTINCT m.id)::int AS n ${base.replace('WHERE', 'JOIN mention_topics mt ON mt.mention_id = m.id AND mt.analysis_id = m.analysis_id WHERE')} AND mt.topic_key <> 'unknown' GROUP BY mt.topic_key ORDER BY n DESC LIMIT 5`,
        [s.project_id, from, to])).rows;
      const clusters = (await c.query<{ id: string; label: string; independent_count: number; publisher_count: number; ids: string[] }>(
        `SELECT sc.id, sc.label, sc.independent_count, sc.publisher_count, array_agg(DISTINCT m.id) AS ids
         ${base.replace('WHERE', 'JOIN cluster_members cm ON cm.mention_id = m.id AND cm.removed_at IS NULL JOIN story_clusters sc ON sc.id = cm.cluster_id AND sc.status = \'active\' WHERE')}
         GROUP BY sc.id ORDER BY sc.independent_count DESC, sc.publisher_count DESC LIMIT 5`, [s.project_id, from, to])).rows;
      const records = (await c.query<{ id: string; title: string; excerpt: string | null; publisher: string | null; publisher_domain: string; published_at: Date | null }>(
        `SELECT DISTINCT ON (m.id) m.id, m.title, m.excerpt, m.publisher, m.publisher_domain, m.published_at ${base} ORDER BY m.id LIMIT 25`, [s.project_id, from, to])).rows;
      return { s, from, to, total, sentiment, topics, clusters, records };
    });
    if (!ctx) return;
    const { s, from, to, total, sentiment, topics, clusters, records } = ctx;
    if (total === 0) {
      await this.db.withTenant(tenantId, SYS, (c) => c.query(
        `UPDATE ai_summaries SET status = 'insufficient_evidence', method = 'extractive', generated_at = now(), uncertainty_notes = $2 WHERE id = $1`,
        [summaryId, ['No collected records matched this project in the selected period.']]));
      return;
    }
    let llm: { s: ReturnType<typeof sanitizeMultiSummary>; model: string; promptVersion: string; usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number } } | null = null;
    // The tenant's monthly AI token limit applies to summaries as it does to article analysis and reports.
    const quota = this.generative && records.length ? await this.db.withTenant(tenantId, SYS, (c) => quotaState(c)) : null;
    if (quota && quota.tokensThisMonth >= quota.monthlyTokenLimit) logEvent('info', 'analysis.summary_quota_reached', { tenantId, summaryId });
    if (this.generative && records.length && quota && quota.tokensThisMonth < quota.monthlyTokenLimit) {
      try {
        const refs = new Map(records.map((r, i) => [`R${i + 1}`, r.id]));
        const res = await this.provider.summarize({ scope: s.scope as 'project' | 'period', language: 'id',
          records: records.map((r, i) => ({ ref: `R${i + 1}`, publisher: r.publisher ?? r.publisher_domain, published: r.published_at?.toISOString() ?? null, title: r.title, excerpt: r.excerpt, syndicated: false })) });
        if (res) llm = { s: sanitizeMultiSummary(res.output, refs), model: res.model, promptVersion: res.promptVersion, usage: res.usage };
      } catch (e) { logEvent('warn', 'analysis.summary_llm_failed', { tenantId, summaryId, message: (e as Error).message }); }
    }
    const allIds = records.map((r) => r.id);
    const sentimentText = sentiment.length ? sentiment.sort((a, b) => b.n - a.n).map((x) => `${x.label} ${x.n}`).join(', ') : 'no sentiment classifications yet';
    const dataClaims: Claim[] = [
      { kind: 'data', text: `${total} original records matched this project between ${from.toISOString().slice(0, 10)} and ${to.toISOString().slice(0, 10)}.`, supportingMentionIds: allIds },
      { kind: 'interpretation', text: `Automated article-level sentiment classification: ${sentimentText}. These are model estimates, not measured public opinion.`, supportingMentionIds: allIds },
      ...(topics.length ? [{ kind: 'interpretation' as const, text: `Most frequent automatically classified topics: ${topics.map((t) => `${topicLabel(t.topic_key)} (${t.n})`).join(', ')}.`, supportingMentionIds: allIds }] : []),
      ...clusters.map((cl) => ({ kind: 'source_fact' as const, text: `Story covered by ${cl.publisher_count} publisher(s), ${cl.independent_count} independent report(s): “${cl.label}”`, quote: cl.label, supportingMentionIds: cl.ids })),
    ];
    await this.db.withTenant(tenantId, SYS, async (c) => {
      const useLlm = llm && llm.s.status === 'ok';
      const claims = useLlm ? [...llm!.s.claims, ...dataClaims.slice(0, 1)] : dataClaims;
      await c.query(
        `UPDATE ai_summaries SET status = 'ready', method = $2, provider = $3, model = $4, prompt_version = $5, summary_text = $6, claims = $7, conflicts = $8,
           uncertainty_notes = $9, supporting_mention_ids = $10, tokens_in = $11, tokens_out = $12, generated_at = now() WHERE id = $1`,
        [summaryId, useLlm ? 'llm' : 'extractive', useLlm ? this.provider.name : 'baseline', useLlm ? llm!.model : 'civicsignal-baseline',
          useLlm ? llm!.promptVersion : 'extractive-period@1', useLlm ? llm!.s.headline : null, JSON.stringify(claims), JSON.stringify(useLlm ? llm!.s.conflicts : []),
          [...(useLlm ? llm!.s.uncertainty : []), 'Counts cover records collected from registered sources only, not all media.', ...(records.length < total ? [`Generated from a sample of ${records.length} of ${total} records.`] : [])],
          [...new Set(claims.flatMap((x) => x.supportingMentionIds))], llm?.usage.inputTokens ?? 0, llm?.usage.outputTokens ?? 0]);
      if (llm) {
        const { cost } = await recordAiUsage(c, tenantId, this.provider.name, llm.model, `${s.scope}-summary`, llm.usage, { summaryId });
        await c.query('UPDATE ai_summaries SET cost_estimate = $2 WHERE id = $1', [summaryId, cost]);
      }
      await setCurrent(c, 'scope = $1 AND project_id = $2', [s.scope, s.project_id], summaryId);
    });
  }
}
