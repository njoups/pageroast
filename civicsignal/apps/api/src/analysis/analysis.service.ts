import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AppConfig, CONFIG } from '../config';
import { Database } from '../database/database.service';
import { logEvent } from '../ingestion/log';
import { ClusterService } from './cluster.service';
import { resolveLanguage } from './language';
import { PROMPTS } from './prompts';
import { ANALYSIS_PROVIDER, FALLBACK_PROVIDER } from './providers';
import { NO_USAGE, ProviderError, type AnalysisProvider, type ProviderResult } from './providers/provider';
import { sanitizeArticleAnalysis, type ArticleAnalysis, type SanitizeReport } from './schemas';
import { TAXONOMY_VERSION, TOPIC_KEYS, type CustomTopic } from './taxonomy';
import { normalizeName } from './text';
import { quotaState, recordAiUsage } from './usage';

export const PIPELINE_VERSION = 'ai-pipeline/1';
const SYS = '00000000-0000-0000-0000-000000000000';

/** Identifies a processing configuration; a change of model, prompt, taxonomy or pipeline makes earlier results "stale". */
export function analysisKey(provider: AnalysisProvider): string {
  return createHash('sha256').update([PIPELINE_VERSION, provider.name, provider.model, PROMPTS.article.id, TAXONOMY_VERSION].join('|')).digest('hex').slice(0, 12);
}

export type AnalyzeOutcome = 'succeeded' | 'partial' | 'skipped' | 'quota_exceeded' | 'not_claimed';

interface MentionRow {
  id: string; title: string; excerpt: string | null; body: string | null; language: string | null; publisher: string | null;
  duplicate_status: string;
}

@Injectable()
export class AnalysisService {
  constructor(
    private readonly db: Database,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(ANALYSIS_PROVIDER) private readonly provider: AnalysisProvider,
    @Inject(FALLBACK_PROVIDER) private readonly fallback: AnalysisProvider,
    private readonly clusters: ClusterService,
  ) {}

  get providerInfo() { return { name: this.provider.name, model: this.provider.model, method: this.provider.method, key: analysisKey(this.provider) }; }

  /**
   * Runs one queued analysis. Idempotent: the ledger row is claimed atomically, so duplicate or late job deliveries
   * do nothing. Throws ProviderError (retryable) to let the queue retry; never throws for permanent outcomes it records.
   */
  async run(tenantId: string, analysisId: string, attempt: number, isFinalAttempt: boolean): Promise<{ outcome: AnalyzeOutcome; clusterId?: string | null; clusterVersion?: number | null }> {
    const started = Date.now();
    const prep = await this.db.withTenant(tenantId, SYS, async (c) => {
      const claimed = (await c.query<{ mention_id: string }>(
        `UPDATE mention_analyses SET status = 'running', attempt = $2, started_at = coalesce(started_at, now()), error = NULL
         WHERE id = $1 AND status IN ('queued','retrying') RETURNING mention_id`, [analysisId, attempt])).rows[0];
      if (!claimed) return null;
      const m = (await c.query<MentionRow>('SELECT id, title, excerpt, body, language, publisher, duplicate_status FROM mentions WHERE id = $1', [claimed.mention_id])).rows[0]!;
      const q = await quotaState(c);
      const custom = (await c.query<CustomTopic>(
        `SELECT DISTINCT pt.id, pt.key, pt.label, pt.description, pt.keywords FROM project_topics pt
         JOIN mention_matches mm ON mm.project_id = pt.project_id WHERE mm.mention_id = $1`, [m.id])).rows;
      await c.query(`UPDATE mentions SET processing_status = 'running' WHERE id = $1`, [m.id]);
      return { m, q, custom };
    });
    if (!prep) return { outcome: 'not_claimed' };
    const { m, q, custom } = prep;
    const stages: Record<string, string> = {};

    // Quotas are checked when work starts (the authoritative moment), not only at enqueue time.
    if (q.analysesToday >= q.dailyMentionLimit || (this.provider.method !== 'baseline' && q.tokensThisMonth >= q.monthlyTokenLimit)) {
      await this.finish(tenantId, analysisId, m.id, 'quota_exceeded', { stages: { quota: q.analysesToday >= q.dailyMentionLimit ? 'daily_mention_limit_reached' : 'monthly_token_limit_reached' } });
      return { outcome: 'quota_exceeded' };
    }

    // 1. Language detection
    const text = [m.title, m.excerpt ?? '', m.body ?? ''].join('\n');
    const lang = resolveLanguage(text, m.language);
    stages.language = `${lang.language}:${lang.method}`;
    const contentStatus = !lang.supported ? 'unsupported_language' : m.body || (m.excerpt && m.excerpt.length >= 60) ? 'ok' : 'headline_only';
    if (!lang.supported) {
      stages.validate = 'skipped:unsupported_language';
      await this.finish(tenantId, analysisId, m.id, 'skipped', { stages, lang, contentStatus });
      return { outcome: 'skipped' };
    }
    // 2. Content validation
    stages.validate = contentStatus;

    // 3–6. Entities, topics, sentiment, summary (one structured provider call)
    let result: ProviderResult<ArticleAnalysis>; let used = this.provider; let fallbackReason: string | null = null;
    try {
      result = await this.provider.analyzeArticle({ title: m.title, excerpt: m.excerpt, body: m.body, publisher: m.publisher, language: lang.language, customTopics: custom });
    } catch (e) {
      const err = e instanceof ProviderError ? e : new ProviderError('network', (e as Error).message);
      if (err.retryable && !isFinalAttempt) {
        await this.db.withTenant(tenantId, SYS, async (c) => {
          await c.query(`UPDATE mention_analyses SET status = 'retrying', error = $2 WHERE id = $1`, [analysisId, JSON.stringify({ kind: err.kind, message: err.message, attempt })]);
          await c.query(`UPDATE mentions SET processing_status = 'queued' WHERE id = $1`, [m.id]);
        });
        throw err;
      }
      if (this.config.ai.fallback !== 'baseline') {
        await this.finish(tenantId, analysisId, m.id, 'failed', { stages: { ...stages, provider: `failed:${err.kind}` }, lang, contentStatus, error: { kind: err.kind, message: err.message } });
        throw err;
      }
      fallbackReason = `${err.kind}: ${err.message}`;
      used = this.fallback;
      result = await this.fallback.analyzeArticle({ title: m.title, excerpt: m.excerpt, body: m.body, publisher: m.publisher, language: lang.language, customTopics: custom });
      logEvent('warn', 'analysis.fallback_used', { tenantId, analysisId, reason: err.kind });
    }
    stages.provider = fallbackReason ? `fallback:${used.name}` : used.name;

    // Output is untrusted: verify every quote against the source text, drop what cannot be verified.
    const allowedTopics = new Set([...TOPIC_KEYS, ...custom.map((t) => t.key)]);
    const { analysis, report } = sanitizeArticleAnalysis(result.output, text, allowedTopics);
    if (contentStatus === 'headline_only') analysis.sentiment.uncertain = analysis.sentiment.uncertain || analysis.sentiment.label !== 'neutral';
    stages.entities = `${analysis.entities.length}`; stages.topics = analysis.topics.map((t) => t.key).join(',');
    stages.sentiment = analysis.sentiment.label; stages.summary = analysis.summary.status;

    // 7–8. Persist, then cluster in the same transaction
    const status = fallbackReason ? 'partial' : 'succeeded';
    const out = await this.db.withTenant(tenantId, SYS, async (c) => {
      await this.persist(c, tenantId, analysisId, m, analysis, used, result, custom, text, contentStatus);
      await this.clusters.detach(c, tenantId, m.id);
      const cl = await this.clusters.assign(c, tenantId, m.id);
      stages.cluster = cl.action; stages.analytics = 'ok:computed_on_read'; stages.alerts = 'not_implemented:milestone_4';
      const usage = used.method === 'baseline' ? null : await recordAiUsage(c, tenantId, used.name, result.model, 'article-analysis', result.usage, { analysisId });
      await this.finish(tenantId, analysisId, m.id, status, {
        stages: { ...stages, sanitize: summarizeReport(report), ...(fallbackReason ? { fallbackReason: fallbackReason.slice(0, 200) } : {}) },
        lang, contentStatus, provider: used, model: result.model, promptVersion: result.promptVersion, usage: result.usage, cost: usage?.cost ?? null, currency: usage?.currency ?? null,
        durationMs: Date.now() - started,
      }, c);
      return cl;
    });
    return { outcome: status, clusterId: out.clusterId, clusterVersion: out.version };
  }

  private async resolveEntity(c: PoolClient, tenantId: string, type: string, name: string, aliases: string[]): Promise<string> {
    const n = normalizeName(name);
    const byAlias = (await c.query<{ entity_id: string }>('SELECT entity_id FROM entity_aliases WHERE entity_type = $1 AND normalized_alias = $2', [type, n])).rows[0];
    let id = byAlias?.entity_id;
    if (!id) {
      id = (await c.query<{ id: string }>(
        `INSERT INTO entities (tenant_id, entity_type, display_name, normalized_name) VALUES ($1,$2,$3,$4)
         ON CONFLICT (tenant_id, entity_type, normalized_name) DO UPDATE SET display_name = entities.display_name RETURNING id`,
        [tenantId, type, name.slice(0, 200), n])).rows[0]!.id;
    }
    // Exact aliases only; an alias already bound to a different entity is never re-pointed (no silent merges).
    for (const a of [name, ...aliases]) {
      const na = normalizeName(a);
      if (!na) continue;
      await c.query(`INSERT INTO entity_aliases (tenant_id, entity_id, entity_type, alias, normalized_alias) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (tenant_id, entity_type, normalized_alias) DO NOTHING`, [tenantId, id, type, a.slice(0, 200), na]);
    }
    return id;
  }

  private async persist(c: PoolClient, tenantId: string, analysisId: string, m: MentionRow, a: ArticleAnalysis, used: AnalysisProvider,
    result: ProviderResult<ArticleAnalysis>, custom: CustomTopic[], text: string, contentStatus: string) {
    const method = used.method === 'baseline' ? 'baseline' : used.method;
    const entityIds = new Map<string, string>();
    for (const e of a.entities) {
      const id = await this.resolveEntity(c, tenantId, e.type, e.name, e.aliases);
      entityIds.set(e.name.toLowerCase(), id);
      const at = text.toLowerCase().indexOf(e.evidence.toLowerCase());
      await c.query(
        `INSERT INTO mention_entities (tenant_id, mention_id, entity_id, entity_type, name, normalized_name, confidence, evidence, evidence_text, evidence_start, evidence_end, model_version, prompt_version, method, analysis_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [tenantId, m.id, id, e.type, e.name, normalizeName(e.name), e.confidence, JSON.stringify({ quote: e.evidence }), e.evidence, at >= 0 ? at : null, at >= 0 ? at + e.evidence.length : null,
          result.model, result.promptVersion, method, analysisId]);
    }
    for (const t of a.topics) {
      const ct = custom.find((x) => x.key === t.key);
      await c.query(
        `INSERT INTO mention_topics (tenant_id, mention_id, topic_key, project_topic_id, confidence, evidence, taxonomy_version, model_version, prompt_version, method, analysis_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [tenantId, m.id, t.key, ct?.id ?? null, t.confidence, JSON.stringify(t.evidence), TAXONOMY_VERSION, result.model, result.promptVersion, method, analysisId]);
    }
    const scope = m.body ? 'full_text' : m.excerpt ? 'headline_and_excerpt' : 'headline';
    await c.query(
      `INSERT INTO sentiment_results (tenant_id, mention_id, label, confidence, evidence, model_version, prompt_version, tokens_in, tokens_out, target_type, target_label, uncertain, text_scope, method, analysis_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'article',$10,$11,$12,$13,$14)`,
      [tenantId, m.id, a.sentiment.label, a.sentiment.confidence, JSON.stringify({ quotes: a.sentiment.evidence, rationale: a.sentiment.rationale }), result.model, result.promptVersion,
        result.usage.inputTokens, result.usage.outputTokens, a.sentiment.target.name, a.sentiment.uncertain, scope, method, analysisId]);
    for (const s of a.entitySentiments) {
      const eid = entityIds.get(s.entity.toLowerCase());
      if (!eid) continue;
      await c.query(
        `INSERT INTO sentiment_results (tenant_id, mention_id, label, confidence, evidence, model_version, prompt_version, target_type, target_entity_id, target_label, uncertain, text_scope, method, analysis_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'entity',$8,$9,$10,$11,$12,$13)`,
        [tenantId, m.id, s.label, s.confidence, JSON.stringify({ quotes: s.evidence }), result.model, result.promptVersion, eid, s.entity, s.uncertain, scope, method, analysisId]);
    }
    const summary = a.summary;
    const sid = (await c.query<{ id: string }>(
      `INSERT INTO ai_summaries (tenant_id, scope, mention_id, status, claims, uncertainty_notes, supporting_mention_ids, method, provider, model, prompt_version, generated_at, is_current)
       VALUES ($1,'mention',$2,$3,$4,$5,$6,$7,$8,$9,$10, now(), true) RETURNING id`,
      [tenantId, m.id, summary.status === 'ok' ? 'ready' : 'insufficient_evidence',
        JSON.stringify(summary.claims.map((cl) => ({ ...cl, supportingMentionIds: [m.id] }))),
        [...summary.uncertainty, ...(contentStatus === 'headline_only' ? ['Only the headline was available for analysis.'] : [])],
        summary.status === 'ok' ? [m.id] : [], used.method === 'baseline' ? 'extractive' : 'llm', used.name, result.model, result.promptVersion])).rows[0]!.id;
    await c.query(`UPDATE ai_summaries SET is_current = false WHERE scope = 'mention' AND mention_id = $1 AND id <> $2 AND is_current`, [m.id, sid]);
  }

  private async finish(tenantId: string, analysisId: string, mentionId: string, status: string, d: {
    stages?: Record<string, string>; lang?: { language: string; confidence: number | null; method: string }; contentStatus?: string; error?: unknown;
    provider?: AnalysisProvider; model?: string; promptVersion?: string; usage?: typeof NO_USAGE; cost?: number | null; currency?: string | null; durationMs?: number;
  }, client?: PoolClient) {
    const work = async (c: PoolClient) => {
      const current = status === 'succeeded' || status === 'partial';
      if (current) await c.query('UPDATE mention_analyses SET is_current = false WHERE mention_id = $1 AND is_current AND id <> $2', [mentionId, analysisId]);
      await c.query(
        `UPDATE mention_analyses SET status = $2, finished_at = now(), stages = $3, language = $4, language_confidence = $5, language_method = $6, content_status = $7,
           error = $8, provider = coalesce($9, provider), model = coalesce($10, model), method = coalesce($11, method),
           prompt_versions = CASE WHEN $12::text IS NULL THEN prompt_versions ELSE jsonb_build_object('article', $12::text, 'taxonomy', $13::text) END,
           tokens_in = $14, tokens_out = $15, tokens_cache_read = $16, cost_estimate = $17, cost_currency = $18, is_current = $19
         WHERE id = $1`,
        [analysisId, status, JSON.stringify({ ...(d.stages ?? {}), ...(d.durationMs !== undefined ? { durationMs: String(d.durationMs) } : {}) }),
          d.lang?.language ?? null, d.lang?.confidence ?? null, d.lang?.method ?? null, d.contentStatus ?? null, d.error ? JSON.stringify(d.error) : null,
          d.provider?.name ?? null, d.model ?? null, d.provider?.method ?? null, d.promptVersion ?? null, TAXONOMY_VERSION,
          d.usage?.inputTokens ?? 0, d.usage?.outputTokens ?? 0, d.usage?.cacheReadTokens ?? 0, d.cost ?? null, d.currency ?? null, current]);
      const mentionStatus = status === 'succeeded' ? 'analyzed' : status;
      await c.query(
        `UPDATE mentions SET processing_status = $2, detected_language = coalesce($3, detected_language), language_confidence = $4, language_method = coalesce($5, language_method),
           analysis_id = CASE WHEN $6 THEN $7::uuid ELSE analysis_id END, analyzed_at = CASE WHEN $6 THEN now() ELSE analyzed_at END WHERE id = $1`,
        [mentionId, mentionStatus, d.lang?.language ?? null, d.lang?.confidence ?? null, d.lang?.method ?? null, current, analysisId]);
      if (current) await c.query(`INSERT INTO usage_records (tenant_id, metric, quantity, period_start, metadata) VALUES ($1,'ai_analyses',1,current_date,$2)`,
        [tenantId, JSON.stringify({ method: d.provider?.method ?? null })]);
    };
    if (client) return work(client);
    return this.db.withTenant(tenantId, SYS, work);
  }
}

function summarizeReport(r: SanitizeReport): string {
  return `dropped entities=${r.droppedEntities} evidence=${r.droppedEvidence} topics=${r.droppedTopics} claims=${r.droppedClaims}${r.forcedUncertain ? ' forced_uncertain' : ''}`;
}
