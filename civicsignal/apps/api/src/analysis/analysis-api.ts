import { Body, Controller, Delete, Get, HttpCode, Inject, Injectable, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsISO8601, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { SessionGuard } from '../auth/session.guard';
import { RequirePermission, TenantGuard } from '../authz/guards';
import { seesAllProjects } from '../authz/permissions';
import { Database } from '../database/database.service';
import { AppError, badRequest, conflict, notFound } from '../common/errors';
import { Auth, AuthContext, Meta, RequestMeta, Tenant, TenantContext } from '../common/request';
import { REDIS } from '../ingestion/ingestion-core.module';
import { KEY_PREFIX, type Redis } from '../ingestion/queue';
import { ProjectsService } from '../projects/projects.service';
import { AnalysisEnqueuer } from './analysis-queue';
import { analysisKey } from './analysis.service';
import { AnalyticsFilter, mentionConditions, Params } from './filters';
import { ANALYSIS_PROVIDER, type AnalysisProvider } from './providers';
import { DEFAULT_TOPICS, TAXONOMY_VERSION } from './taxonomy';
import { normalizeName } from './text';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

class BackfillDto {
  @ApiPropertyOptional({ enum: ['pending', 'stale', 'failed'] }) @IsOptional() @IsIn(['pending', 'stale', 'failed']) scope?: 'pending' | 'stale' | 'failed';
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit?: number;
}
class TopicCategoryDto {
  @ApiProperty({ example: 'custom:bansos' }) @Matches(/^custom:[a-z0-9_]{2,40}$/) key: string;
  @ApiProperty() @Transform(trim) @IsString() @MinLength(2) @MaxLength(80) label: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(500) description?: string;
  @ApiPropertyOptional() @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) @MaxLength(60, { each: true }) keywords?: string[];
}
class AliasDto { @ApiProperty() @Transform(trim) @IsString() @MinLength(1) @MaxLength(200) alias: string }
class SummaryRequestDto {
  @ApiPropertyOptional() @IsOptional() @IsISO8601() periodStart?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() periodEnd?: string;
}
class SettingsDto {
  @IsOptional() @IsBoolean() autoAnalyze?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100000) dailyMentionLimit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1000) @Max(10_000_000_000) monthlyTokenLimit?: number;
}
class ClustersQuery extends AnalyticsFilter { @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number }

@Injectable()
export class AnalysisApiService {
  constructor(private readonly db: Database, private readonly audit: AuditService, private readonly projects: ProjectsService, private readonly enqueuer: AnalysisEnqueuer,
    @Inject(ANALYSIS_PROVIDER) private readonly provider: AnalysisProvider, @Inject(REDIS) private readonly redis: Redis | null) {}

  /** Throws 404 unless the mention exists and is visible to the caller under project-level rules. */
  private async visibleMention(c: import('pg').PoolClient, auth: AuthContext, t: TenantContext, id: string) {
    const p = new Params();
    const where = [`m.id = ${p.add(id)}`, ...mentionConditions(p, auth, t)].filter((x) => !x.startsWith('m.duplicate_status'));
    const r = (await c.query(`SELECT m.id, m.title, m.url, m.publisher, m.publisher_domain, m.excerpt, m.body, m.language, m.detected_language, m.language_confidence,
      m.language_method, m.processing_status, m.analysis_id, m.analyzed_at, m.cluster_id, m.published_at, m.discovered_at, m.duplicate_status FROM mentions m WHERE ${where.join(' AND ')}`, p.values)).rows[0];
    if (!r) throw notFound('Mention');
    return r;
  }

  analysis(auth: AuthContext, t: TenantContext, id: string) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const m = await this.visibleMention(c, auth, t, id);
      const history = (await c.query(`SELECT id, status, trigger, provider, model, method, prompt_versions, language, language_confidence, language_method, content_status,
        stages, error, attempt, tokens_in, tokens_out, cost_estimate, cost_currency, is_current, queued_at, started_at, finished_at
        FROM mention_analyses WHERE mention_id = $1 ORDER BY queued_at DESC LIMIT 10`, [id])).rows;
      const aid = m.analysis_id as string | null;
      const entities = aid ? (await c.query(`SELECT me.entity_id, e.display_name, me.entity_type, me.name AS mentioned_as, me.evidence_text, me.evidence_start, me.evidence_end,
        me.confidence, me.method, me.model_version, me.prompt_version FROM mention_entities me JOIN entities e ON e.id = me.entity_id WHERE me.analysis_id = $1 ORDER BY me.confidence DESC`, [aid])).rows : [];
      const topics = aid ? (await c.query(`SELECT mt.topic_key, coalesce(pt.label, mt.topic_key) AS custom_label, mt.confidence, mt.evidence, mt.taxonomy_version, mt.method, mt.model_version, mt.created_at
        FROM mention_topics mt LEFT JOIN project_topics pt ON pt.id = mt.project_topic_id WHERE mt.analysis_id = $1 ORDER BY mt.confidence DESC`, [aid])).rows : [];
      const sentiment = aid ? (await c.query(`SELECT label, confidence, uncertain, target_type, target_entity_id, target_label, evidence, text_scope, method, model_version, prompt_version, created_at
        FROM sentiment_results WHERE analysis_id = $1 ORDER BY target_type`, [aid])).rows : [];
      const summary = (await c.query(`SELECT id, status, summary_text, claims, uncertainty_notes, conflicts, supporting_mention_ids, method, provider, model, prompt_version, generated_at
        FROM ai_summaries WHERE scope = 'mention' AND mention_id = $1 AND is_current`, [id])).rows[0] ?? null;
      let cluster = null;
      if (m.cluster_id) {
        cluster = (await c.query(`SELECT id, label, member_count, independent_count, publisher_count, confidence, first_seen_at, last_seen_at, version FROM story_clusters WHERE id = $1 AND status = 'active'`, [m.cluster_id])).rows[0] ?? null;
      }
      const current = history.find((h) => h.is_current) ?? null;
      return {
        mention: { ...m, body: undefined, hasBody: !!m.body },
        processing: { status: m.processing_status, current, history, provider: current?.provider ?? null, latest: history[0] ?? null },
        language: { feedDeclared: m.language, detected: m.detected_language, confidence: m.language_confidence, method: m.language_method },
        entities, topics, sentiment, summary, cluster,
        taxonomy: { version: TAXONOMY_VERSION, labels: Object.fromEntries(DEFAULT_TOPICS.map((x) => [x.key, x.label])) },
        disclaimer: 'Automated classifications are estimates produced by the method shown; they are not verified facts or measured public opinion.',
      };
    });
  }

  private async tenantRateLimit(tenantId: string, limit = 30) {
    if (!this.redis) return;
    const k = `${KEY_PREFIX}:reprocess:${tenantId}:${Math.floor(Date.now() / 60_000)}`;
    const n = await this.redis.incr(k); if (n === 1) await this.redis.expire(k, 120);
    if (n > limit) throw new AppError(429, 'rate_limited', `Reprocessing is limited to ${limit} requests per minute per organization`);
  }

  async reprocess(auth: AuthContext, t: TenantContext, id: string, meta: RequestMeta) {
    if (!this.enqueuer.available) throw new AppError(503, 'queue_unavailable', 'The analysis queue (Redis) is not configured on this server');
    await this.db.withTenant(t.orgId, auth.userId, (c) => this.visibleMention(c, auth, t, id));
    await this.tenantRateLimit(t.orgId);
    const r = await this.enqueuer.enqueueMentions(t.orgId, [id], 'reprocess', auth.userId);
    await this.db.withTenant(t.orgId, auth.userId, (c) => this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'analysis.reprocess_requested', targetType: 'mention', targetId: id, metadata: { analysisIds: r.queued }, meta }));
    if (!r.queued.length) throw conflict('reprocess_already_queued', 'A reprocessing request for this record was already queued in the last minute');
    return { analysisId: r.queued[0], status: 'queued' };
  }

  async backfill(auth: AuthContext, t: TenantContext, dto: BackfillDto, meta: RequestMeta) {
    if (!this.enqueuer.available) throw new AppError(503, 'queue_unavailable', 'The analysis queue (Redis) is not configured on this server');
    await this.tenantRateLimit(t.orgId, 5);
    const scope = dto.scope ?? 'pending'; const limit = dto.limit ?? 200;
    const key = analysisKey(this.provider);
    const ids = await this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const cond = scope === 'pending' ? `m.analysis_id IS NULL AND m.processing_status IN ('pending','quota_exceeded')`
        : scope === 'failed' ? `m.processing_status = 'failed'`
        // Stale: analysed, or skipped (e.g. language undetermined), under a different processing configuration.
        : `((m.analysis_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM mention_analyses a WHERE a.id = m.analysis_id AND a.idempotency_key LIKE $2 || ':%'))
            OR (m.processing_status = 'skipped' AND NOT EXISTS (SELECT 1 FROM mention_analyses a WHERE a.mention_id = m.id AND a.idempotency_key LIKE $2 || ':%')))`;
      return (await c.query<{ id: string }>(`SELECT m.id FROM mentions m WHERE m.duplicate_status = 'original' AND ${cond} ORDER BY m.discovered_at DESC LIMIT $1`,
        scope === 'stale' ? [limit, key] : [limit])).rows.map((r) => r.id);
    });
    const r = await this.enqueuer.enqueueMentions(t.orgId, ids, scope === 'pending' ? 'backfill' : 'reprocess', auth.userId);
    await this.db.withTenant(t.orgId, auth.userId, (c) => this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'analysis.backfill_requested', metadata: { scope, requested: ids.length, queued: r.queued.length }, meta }));
    return { scope, considered: ids.length, queued: r.queued.length };
  }

  sentiment(auth: AuthContext, t: TenantContext, f: AnalyticsFilter) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const p = new Params(); const w = mentionConditions(p, auth, t, f).join(' AND ');
      const dist = (await c.query(`SELECT sr.label, count(*)::int AS n, count(*) FILTER (WHERE sr.uncertain)::int AS uncertain
        FROM mentions m JOIN sentiment_results sr ON sr.mention_id = m.id AND sr.analysis_id = m.analysis_id AND sr.target_type = 'article' WHERE ${w} GROUP BY sr.label`, p.values)).rows;
      const series = (await c.query(`SELECT to_char(date_trunc('day', coalesce(m.published_at, m.discovered_at)), 'YYYY-MM-DD') AS day, sr.label, count(*)::int AS n
        FROM mentions m JOIN sentiment_results sr ON sr.mention_id = m.id AND sr.analysis_id = m.analysis_id AND sr.target_type = 'article' WHERE ${w} GROUP BY 1, 2 ORDER BY 1`, p.values)).rows;
      const status = (await c.query(`SELECT m.processing_status AS status, count(*)::int AS n FROM mentions m WHERE ${w} GROUP BY 1`, p.values)).rows;
      const methods = (await c.query(`SELECT a.method, a.provider, a.model, count(*)::int AS n FROM mentions m JOIN mention_analyses a ON a.id = m.analysis_id WHERE ${w} GROUP BY 1, 2, 3`, p.values)).rows;
      return { distribution: dist, series, processing: status, methods, definition: 'Count of original records by article-level sentiment of their current analysis. Uncertain = low-confidence classifications. Days are UTC.' };
    });
  }

  topics(auth: AuthContext, t: TenantContext, f: AnalyticsFilter) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const p = new Params(); const w = mentionConditions(p, auth, t, f).join(' AND ');
      const rows = (await c.query(`SELECT mt.topic_key, max(pt.label) AS custom_label, count(DISTINCT m.id)::int AS n, round(avg(mt.confidence)::numeric, 2) AS avg_confidence
        FROM mentions m JOIN mention_topics mt ON mt.mention_id = m.id AND mt.analysis_id = m.analysis_id LEFT JOIN project_topics pt ON pt.id = mt.project_topic_id
        WHERE ${w} GROUP BY mt.topic_key ORDER BY n DESC`, p.values)).rows;
      const labels = Object.fromEntries(DEFAULT_TOPICS.map((x) => [x.key, x.label]));
      return { taxonomyVersion: TAXONOMY_VERSION, topics: rows.map((r) => ({ ...r, label: r.custom_label ?? labels[r.topic_key] ?? r.topic_key })),
        definition: 'Original records per topic in their current analysis; a record can carry up to three topics. "Unknown" = insufficient evidence.' };
    });
  }

  entities(auth: AuthContext, t: TenantContext, f: AnalyticsFilter, limit = 25) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const p = new Params(); const w = mentionConditions(p, auth, t, f).join(' AND ');
      const rows = (await c.query(`SELECT e.id, e.display_name, e.entity_type, count(DISTINCT m.id)::int AS mentions,
          count(DISTINCT m.id) FILTER (WHERE sr.label = 'negative')::int AS negative_toward, count(DISTINCT m.id) FILTER (WHERE sr.label = 'positive')::int AS positive_toward
        FROM mentions m JOIN mention_entities me ON me.mention_id = m.id AND me.analysis_id = m.analysis_id JOIN entities e ON e.id = me.entity_id
        LEFT JOIN sentiment_results sr ON sr.mention_id = m.id AND sr.analysis_id = m.analysis_id AND sr.target_type = 'entity' AND sr.target_entity_id = e.id
        WHERE ${w} GROUP BY e.id ORDER BY mentions DESC, e.display_name LIMIT ${p.add(limit)}`, p.values)).rows;
      return { entities: rows, definition: 'Original records mentioning the entity in their current analysis. Entity-targeted tone is shown only where the analysis method produced it.' };
    });
  }

  clusters(auth: AuthContext, t: TenantContext, f: ClustersQuery) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const p = new Params(); const w = mentionConditions(p, auth, t, f).join(' AND ');
      const rows = (await c.query(`SELECT sc.id, sc.label, sc.member_count, sc.independent_count, sc.publisher_count, sc.confidence, sc.first_seen_at, sc.last_seen_at, sc.version,
          count(DISTINCT m.id)::int AS visible_members
        FROM story_clusters sc JOIN cluster_members cm ON cm.cluster_id = sc.id AND cm.removed_at IS NULL JOIN mentions m ON m.id = cm.mention_id
        WHERE sc.status = 'active' AND ${w} GROUP BY sc.id ORDER BY sc.last_seen_at DESC LIMIT ${p.add(f.limit ?? 30)}`, p.values)).rows;
      return { clusters: rows };
    });
  }

  cluster(auth: AuthContext, t: TenantContext, id: string) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const cl = (await c.query('SELECT * FROM story_clusters WHERE id = $1', [id])).rows[0];
      const p = new Params(); const w = mentionConditions(p, auth, t).join(' AND ');
      const members = (await c.query(`SELECT m.id, m.title, m.url, m.publisher, m.publisher_domain, m.published_at, m.discovered_at, cm.score, cm.reasons, cm.is_syndicated, cm.added_at,
          (SELECT sr.label FROM sentiment_results sr WHERE sr.analysis_id = m.analysis_id AND sr.target_type = 'article' LIMIT 1) AS sentiment
        FROM cluster_members cm JOIN mentions m ON m.id = cm.mention_id WHERE cm.cluster_id = ${p.add(id)} AND cm.removed_at IS NULL AND ${w}
        ORDER BY coalesce(m.published_at, m.discovered_at)`, p.values)).rows;
      if (!cl || members.length === 0) throw notFound('Story cluster');   // no visible member → not visible at all
      const events = (await c.query(`SELECT event, mention_id, details, at FROM cluster_events WHERE cluster_id = $1 ORDER BY at DESC LIMIT 50`, [id])).rows;
      const visible = new Set(members.map((m) => m.id));
      const summaries = (await c.query(`SELECT id, status, summary_text, claims, conflicts, uncertainty_notes, supporting_mention_ids, method, provider, model, prompt_version, generated_at
        FROM ai_summaries WHERE scope = 'cluster' AND cluster_id = $1 AND is_current`, [id])).rows
        .map((s) => ({ ...s, claims: (s.claims as Array<{ supportingMentionIds: string[] }>).filter((cl2) => cl2.supportingMentionIds.every((x) => visible.has(x))) }));
      return { cluster: cl, members, hiddenMembers: cl.member_count - members.length, events, summary: summaries[0] ?? null };
    });
  }

  topicCategories(auth: AuthContext, t: TenantContext, projectId: string) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      await this.projects.assertVisible(c, auth, t, projectId);
      const custom = (await c.query('SELECT id, key, label, description, keywords, created_at FROM project_topics WHERE project_id = $1 ORDER BY label', [projectId])).rows;
      return { taxonomyVersion: TAXONOMY_VERSION, default: DEFAULT_TOPICS.map(({ key, label, labelId, description }) => ({ key, label, labelId, description })), custom };
    });
  }

  addTopicCategory(auth: AuthContext, t: TenantContext, projectId: string, dto: TopicCategoryDto, meta: RequestMeta) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const pr = await this.projects.assertVisible(c, auth, t, projectId, true);
      if (pr.status === 'archived') throw conflict('project_archived', 'Unarchive the project first');
      const r = await c.query(`INSERT INTO project_topics (tenant_id, project_id, key, label, description, keywords, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (project_id, key) DO NOTHING RETURNING id, key, label, description, keywords`, [t.orgId, projectId, dto.key, dto.label, dto.description ?? null, dto.keywords ?? [], auth.userId]);
      if (!r.rows[0]) throw conflict('topic_exists', 'A category with this key already exists in the project');
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'topic_category.created', targetType: 'project', targetId: projectId, metadata: { key: dto.key }, meta });
      return { ...r.rows[0], note: 'Applies to records analysed from now on; use reprocessing to apply it to earlier records.' };
    });
  }

  removeTopicCategory(auth: AuthContext, t: TenantContext, projectId: string, id: string, meta: RequestMeta) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      await this.projects.assertVisible(c, auth, t, projectId);
      const r = await c.query('DELETE FROM project_topics WHERE id = $1 AND project_id = $2 RETURNING key', [id, projectId]);
      if (!r.rowCount) throw notFound('Topic category');
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'topic_category.deleted', targetType: 'project', targetId: projectId, metadata: { key: r.rows[0].key }, meta });
    });
  }

  entity(auth: AuthContext, t: TenantContext, id: string) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const e = (await c.query('SELECT id, entity_type, display_name, normalized_name, origin, created_at FROM entities WHERE id = $1', [id])).rows[0];
      if (!e) throw notFound('Entity');
      const p = new Params(); const w = mentionConditions(p, auth, t, { entityId: id }).join(' AND ');
      const n = (await c.query(`SELECT count(*)::int AS n FROM mentions m WHERE ${w}`, p.values)).rows[0].n;
      if (!seesAllProjects(t.role) && n === 0) throw notFound('Entity');
      const aliases = (await c.query('SELECT id, alias, created_by, created_at FROM entity_aliases WHERE entity_id = $1 ORDER BY alias', [id])).rows;
      return { ...e, aliases, visibleMentions: n };
    });
  }

  addAlias(auth: AuthContext, t: TenantContext, id: string, alias: string, meta: RequestMeta) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const e = (await c.query<{ entity_type: string }>('SELECT entity_type FROM entities WHERE id = $1', [id])).rows[0];
      if (!e) throw notFound('Entity');
      const n = normalizeName(alias);
      if (!n) throw badRequest('validation_failed', 'Alias has no letters or digits');
      const r = await c.query(`INSERT INTO entity_aliases (tenant_id, entity_id, entity_type, alias, normalized_alias, created_by) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (tenant_id, entity_type, normalized_alias) DO NOTHING RETURNING id`, [t.orgId, id, e.entity_type, alias, n, auth.userId]);
      if (!r.rowCount) throw conflict('alias_taken', 'This alias already belongs to an entity of this type; aliases are never re-pointed automatically');
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'entity.alias_added', targetType: 'entity', targetId: id, metadata: { alias }, meta });
      return { id: r.rows[0].id, alias };
    });
  }

  removeAlias(auth: AuthContext, t: TenantContext, id: string, aliasId: string, meta: RequestMeta) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const r = await c.query('DELETE FROM entity_aliases WHERE id = $1 AND entity_id = $2 RETURNING alias', [aliasId, id]);
      if (!r.rowCount) throw notFound('Alias');
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'entity.alias_removed', targetType: 'entity', targetId: id, metadata: { alias: r.rows[0].alias }, meta });
    });
  }

  async requestSummary(auth: AuthContext, t: TenantContext, projectId: string, dto: SummaryRequestDto, meta: RequestMeta) {
    if (!this.enqueuer.available) throw new AppError(503, 'queue_unavailable', 'The analysis queue (Redis) is not configured on this server');
    const period = !!(dto.periodStart || dto.periodEnd);
    if (period && (!dto.periodStart || !dto.periodEnd || dto.periodEnd <= dto.periodStart)) throw badRequest('validation_failed', 'periodStart and periodEnd are both required, end after start');
    const id = await this.db.withTenant(t.orgId, auth.userId, async (c) => {
      await this.projects.assertVisible(c, auth, t, projectId);
      const r = await c.query<{ id: string }>(`INSERT INTO ai_summaries (tenant_id, scope, project_id, period_start, period_end, status, requested_by, is_current)
        VALUES ($1,$2,$3,$4,$5,'queued',$6,false) RETURNING id`, [t.orgId, period ? 'period' : 'project', projectId, dto.periodStart ?? null, dto.periodEnd ?? null, auth.userId]);
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'summary.requested', targetType: 'project', targetId: projectId, metadata: { summaryId: r.rows[0]!.id }, meta });
      return r.rows[0]!.id;
    });
    await this.enqueuer.enqueueProjectSummary(t.orgId, id);
    return { summaryId: id, status: 'queued' };
  }

  summaries(auth: AuthContext, t: TenantContext, projectId: string) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      await this.projects.assertVisible(c, auth, t, projectId);
      return (await c.query(`SELECT id, scope, status, period_start, period_end, summary_text, claims, conflicts, uncertainty_notes, supporting_mention_ids, method, provider, model,
        prompt_version, tokens_in, tokens_out, cost_estimate, is_current, generated_at, created_at FROM ai_summaries WHERE project_id = $1 ORDER BY created_at DESC LIMIT 20`, [projectId])).rows;
    });
  }

  usage(auth: AuthContext, t: TenantContext, days: number) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const byDay = (await c.query(`SELECT to_char(date_trunc('day', recorded_at), 'YYYY-MM-DD') AS day, provider, model, sum(tokens_in)::bigint AS tokens_in, sum(tokens_out)::bigint AS tokens_out,
        sum(tokens_cache_read)::bigint AS tokens_cache_read, sum(cost_estimate) AS cost_estimate, count(*) FILTER (WHERE cost_estimate IS NULL)::int AS unpriced_calls, max(currency) AS currency,
        max(pricing_updated_at) AS pricing_updated_at, count(*)::int AS calls
        FROM ai_usage_records WHERE recorded_at > now() - make_interval(days => $1) GROUP BY 1, 2, 3 ORDER BY 1 DESC`, [days])).rows;
      const analyses = (await c.query(`SELECT status, method, count(*)::int AS n FROM mention_analyses WHERE queued_at > now() - make_interval(days => $1) GROUP BY 1, 2`, [days])).rows;
      const settings = (await c.query('SELECT auto_analyze, daily_mention_limit, monthly_token_limit, updated_at FROM ai_tenant_settings')).rows[0]
        ?? { auto_analyze: true, daily_mention_limit: 500, monthly_token_limit: 2_000_000, updated_at: null };
      const month = (await c.query(`SELECT coalesce(sum(tokens_in + tokens_out), 0)::bigint AS tokens FROM ai_usage_records WHERE recorded_at >= date_trunc('month', now())`)).rows[0].tokens;
      const today = (await c.query(`SELECT count(*)::int AS n FROM mention_analyses WHERE status IN ('succeeded','partial') AND finished_at >= date_trunc('day', now())`)).rows[0].n;
      return {
        provider: { name: this.provider.name, model: this.provider.model, method: this.provider.method },
        byDay, analyses, settings, consumption: { tokensThisMonth: Number(month), analysesToday: today },
        notice: 'Cost figures are estimates computed from operator-configured prices (with the price timestamp). They are not invoices. Calls without a configured price show no cost.',
      };
    });
  }

  updateSettings(auth: AuthContext, t: TenantContext, dto: SettingsDto, meta: RequestMeta) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const r = await c.query(`INSERT INTO ai_tenant_settings (tenant_id, auto_analyze, daily_mention_limit, monthly_token_limit, updated_by, updated_at)
        VALUES ($1, coalesce($2, true), coalesce($3, 500), coalesce($4, 2000000), $5, now())
        ON CONFLICT (tenant_id) DO UPDATE SET auto_analyze = coalesce($2, ai_tenant_settings.auto_analyze), daily_mention_limit = coalesce($3, ai_tenant_settings.daily_mention_limit),
          monthly_token_limit = coalesce($4, ai_tenant_settings.monthly_token_limit), updated_by = $5, updated_at = now()
        RETURNING auto_analyze, daily_mention_limit, monthly_token_limit, updated_at`, [t.orgId, dto.autoAnalyze ?? null, dto.dailyMentionLimit ?? null, dto.monthlyTokenLimit ?? null, auth.userId]);
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'ai.settings_updated', metadata: { ...dto }, meta });
      return r.rows[0];
    });
  }
}

class DaysQuery { @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(366) days?: number }
class LimitQuery extends AnalyticsFilter { @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number }

@ApiTags('analysis')
@Controller('organizations/:orgId')
@UseGuards(SessionGuard, TenantGuard)
export class AnalysisController {
  constructor(private readonly svc: AnalysisApiService) {}

  @Get('mentions/:id/analysis') @RequirePermission('mentions:read')
  analysis(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.analysis(a, t, id); }

  @Post('mentions/:id/reprocess') @HttpCode(202) @RequirePermission('analysis:reprocess')
  reprocess(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Meta() m: RequestMeta) { return this.svc.reprocess(a, t, id, m); }

  @Post('analysis/backfill') @HttpCode(202) @RequirePermission('analysis:reprocess')
  backfill(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Body() dto: BackfillDto, @Meta() m: RequestMeta) { return this.svc.backfill(a, t, dto, m); }

  @Get('analytics/sentiment') @RequirePermission('mentions:read')
  sentiment(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Query() f: AnalyticsFilter) { return this.svc.sentiment(a, t, f); }
  @Get('analytics/topics') @RequirePermission('mentions:read')
  topics(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Query() f: AnalyticsFilter) { return this.svc.topics(a, t, f); }
  @Get('analytics/entities') @RequirePermission('mentions:read')
  entities(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Query() f: LimitQuery) { return this.svc.entities(a, t, f, f.limit); }

  @Get('projects/:projectId/sentiment') @RequirePermission('mentions:read')
  pSentiment(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('projectId', ParseUUIDPipe) p: string, @Query() f: AnalyticsFilter) { return this.svc.sentiment(a, t, { ...f, projectId: p }); }
  @Get('projects/:projectId/topics') @RequirePermission('mentions:read')
  pTopics(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('projectId', ParseUUIDPipe) p: string, @Query() f: AnalyticsFilter) { return this.svc.topics(a, t, { ...f, projectId: p }); }
  @Get('projects/:projectId/entities') @RequirePermission('mentions:read')
  pEntities(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('projectId', ParseUUIDPipe) p: string, @Query() f: LimitQuery) { return this.svc.entities(a, t, { ...f, projectId: p }, f.limit); }

  @Get('clusters') @RequirePermission('mentions:read')
  clusters(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Query() f: ClustersQuery) { return this.svc.clusters(a, t, f); }
  @Get('clusters/:id') @RequirePermission('mentions:read')
  cluster(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.cluster(a, t, id); }

  @Get('projects/:projectId/topic-categories') @RequirePermission('projects:read')
  cats(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('projectId', ParseUUIDPipe) p: string) { return this.svc.topicCategories(a, t, p); }
  @Post('projects/:projectId/topic-categories') @RequirePermission('projects:update')
  addCat(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('projectId', ParseUUIDPipe) p: string, @Body() dto: TopicCategoryDto, @Meta() m: RequestMeta) { return this.svc.addTopicCategory(a, t, p, dto, m); }
  @Delete('projects/:projectId/topic-categories/:id') @HttpCode(204) @RequirePermission('projects:update')
  delCat(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('projectId', ParseUUIDPipe) p: string, @Param('id', ParseUUIDPipe) id: string, @Meta() m: RequestMeta) { return this.svc.removeTopicCategory(a, t, p, id, m); }

  @Get('entities/:id') @RequirePermission('mentions:read')
  entity(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.entity(a, t, id); }
  @Post('entities/:id/aliases') @RequirePermission('analysis:reprocess')
  addAlias(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AliasDto, @Meta() m: RequestMeta) { return this.svc.addAlias(a, t, id, dto.alias, m); }
  @Delete('entities/:id/aliases/:aliasId') @HttpCode(204) @RequirePermission('analysis:reprocess')
  delAlias(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Param('aliasId', ParseUUIDPipe) aliasId: string, @Meta() m: RequestMeta) { return this.svc.removeAlias(a, t, id, aliasId, m); }

  @Post('projects/:projectId/summaries') @HttpCode(202) @RequirePermission('reports:generate')
  reqSummary(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('projectId', ParseUUIDPipe) p: string, @Body() dto: SummaryRequestDto, @Meta() m: RequestMeta) { return this.svc.requestSummary(a, t, p, dto, m); }
  @Get('projects/:projectId/summaries') @RequirePermission('projects:read')
  summaries(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('projectId', ParseUUIDPipe) p: string) { return this.svc.summaries(a, t, p); }

  @Get('ai/usage') @RequirePermission('ai:settings')
  usage(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Query() q: DaysQuery) { return this.svc.usage(a, t, q.days ?? 30); }
  @Put('ai/settings') @RequirePermission('ai:settings')
  settings(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Body() dto: SettingsDto, @Meta() m: RequestMeta) { return this.svc.updateSettings(a, t, dto, m); }
}
