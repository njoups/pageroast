import { Controller, Get, Injectable, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import { SessionGuard } from '../auth/session.guard';
import { RequirePermission, TenantGuard } from '../authz/guards';
import { seesAllProjects } from '../authz/permissions';
import { Database } from '../database/database.service';
import { notFound } from '../common/errors';
import { Auth, AuthContext, Tenant, TenantContext } from '../common/request';

export class MentionsQuery {
  @IsOptional() @IsString() @MaxLength(500) q?: string;
  @IsOptional() @IsUUID() projectId?: string;
  @IsOptional() @IsUUID() sourceId?: string;
  @IsOptional() @Matches(/^[a-z]{2,3}$/) language?: string;
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
  @IsOptional() @IsIn(['published', 'discovered']) dateField?: 'published' | 'discovered';
  @IsOptional() @IsIn(['published', 'discovered', 'relevance']) sort?: 'published' | 'discovered' | 'relevance';
  @IsOptional() @Transform(({ value }) => value === 'true' || value === true) includeDuplicates?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10000) offset?: number;
  @IsOptional() @Matches(/^(custom:)?[a-z_0-9]{2,40}$/) topic?: string;
  @IsOptional() @IsUUID() entityId?: string;
  @IsOptional() @IsIn(['positive', 'negative', 'neutral', 'mixed', 'unknown']) sentiment?: string;
  @IsOptional() @IsUUID() clusterId?: string;
}

const ITEM_COLS = `m.id, m.title, m.url, m.canonical_url, m.publisher, m.publisher_domain, m.excerpt, m.author, m.categories, m.language,
  m.published_at, m.discovered_at, m.last_seen_at, m.source_id, s.name AS source_name, m.source_type, m.duplicate_status, m.duplicate_of,
  m.duplicate_reason, m.processing_status, m.availability, m.retention_expires_at, m.last_verified_at,
  m.provenance->'licence'->>'attribution' AS attribution, m.provenance->'licence'->>'redistributionRestrictions' AS redistribution_restrictions,
  m.provenance->>'connector' AS connector, m.provenance->>'runId' AS run_id, m.provenance->>'gdeltSeenAt' AS gdelt_seen_at,
  m.detected_language, m.cluster_id,
  (SELECT jsonb_build_object('label', sr.label, 'confidence', sr.confidence, 'uncertain', sr.uncertain, 'method', sr.method)
     FROM sentiment_results sr WHERE sr.analysis_id = m.analysis_id AND sr.target_type = 'article' LIMIT 1) AS sentiment,
  coalesce((SELECT jsonb_agg(mt.topic_key ORDER BY mt.confidence DESC) FROM mention_topics mt WHERE mt.analysis_id = m.analysis_id AND mt.topic_key <> 'unknown'), '[]'::jsonb) AS topics`;

@Injectable()
export class MentionsService {
  constructor(private readonly db: Database) {}

  /**
   * Owners/admins see every mention in the tenant. Other roles see only mentions matched to projects they are assigned
   * to; an explicit projectId outside their projects returns no rows (the project's existence is not revealed).
   */
  search(auth: AuthContext, t: TenantContext, f: MentionsQuery) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const p: unknown[] = [];
      const add = (v: unknown) => { p.push(v); return `$${p.length}`; };
      const where: string[] = [];
      const all = seesAllProjects(t.role);
      if (!all) {
        where.push(`EXISTS (SELECT 1 FROM mention_matches mm JOIN project_members pm ON pm.project_id = mm.project_id AND pm.user_id = ${add(auth.userId)}
          WHERE mm.mention_id = m.id ${f.projectId ? `AND mm.project_id = ${add(f.projectId)}` : ''})`);
      } else if (f.projectId) {
        where.push(`EXISTS (SELECT 1 FROM mention_matches mm WHERE mm.mention_id = m.id AND mm.project_id = ${add(f.projectId)})`);
      }
      if (!f.includeDuplicates) where.push(`m.duplicate_status = 'original'`);
      if (f.sourceId) where.push(`m.source_id = ${add(f.sourceId)}`);
      if (f.topic) where.push(`EXISTS (SELECT 1 FROM mention_topics mt WHERE mt.mention_id = m.id AND mt.analysis_id = m.analysis_id AND mt.topic_key = ${add(f.topic)})`);
      if (f.entityId) where.push(`EXISTS (SELECT 1 FROM mention_entities me WHERE me.mention_id = m.id AND me.analysis_id = m.analysis_id AND me.entity_id = ${add(f.entityId)})`);
      if (f.sentiment) where.push(`EXISTS (SELECT 1 FROM sentiment_results sr WHERE sr.mention_id = m.id AND sr.analysis_id = m.analysis_id AND sr.target_type = 'article' AND sr.label = ${add(f.sentiment)})`);
      if (f.clusterId) where.push(`m.cluster_id = ${add(f.clusterId)}`);
      if (f.language) where.push(`m.language = ${add(f.language)}`);
      const dateCol = f.dateField === 'published' ? 'm.published_at' : 'm.discovered_at';
      if (f.from) where.push(`${dateCol} >= ${add(f.from)}::timestamptz`);
      if (f.to) where.push(`${dateCol} <= ${add(f.to)}::timestamptz`);
      let rank = '0';
      if (f.q?.trim()) {
        const tsq = `websearch_to_tsquery('simple', ${add(f.q.trim())})`;   // never raises on user input
        where.push(`m.search_tsv @@ ${tsq}`);
        rank = `ts_rank(m.search_tsv, ${tsq})`;
      }
      const order = f.sort === 'relevance' && f.q ? `${rank} DESC, m.discovered_at DESC`
        : f.sort === 'discovered' ? 'm.discovered_at DESC' : 'm.published_at DESC NULLS LAST, m.discovered_at DESC';
      const limit = f.limit ?? 25; const offset = f.offset ?? 0;
      const rows = (await c.query(
        `SELECT ${ITEM_COLS}, count(*) OVER() AS total,
           coalesce((SELECT jsonb_agg(jsonb_build_object('projectId', mm.project_id, 'projectName', pr.name, 'queryId', mm.query_id, 'queryName', q.name, 'terms', mm.matched_terms))
             FROM mention_matches mm JOIN projects pr ON pr.id = mm.project_id JOIN monitoring_queries q ON q.id = mm.query_id
             WHERE mm.mention_id = m.id ${all ? '' : `AND EXISTS (SELECT 1 FROM project_members pm2 WHERE pm2.project_id = mm.project_id AND pm2.user_id = ${add(auth.userId)})`}), '[]'::jsonb) AS matches
         FROM mentions m JOIN sources s ON s.id = m.source_id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY ${order} LIMIT ${add(limit)} OFFSET ${add(offset)}`, p)).rows;
      const total = rows[0] ? Number(rows[0].total) : 0;
      return { items: rows.map(({ total: _t, ...r }) => ({ ...r, dataOrigin: 'live' })), total, limit, offset };
    });
  }

  get(auth: AuthContext, t: TenantContext, id: string) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const all = seesAllProjects(t.role);
      const r = (await c.query(
        `SELECT ${ITEM_COLS}, m.body, m.content_hash, m.provenance FROM mentions m JOIN sources s ON s.id = m.source_id WHERE m.id = $1
         ${all ? '' : `AND EXISTS (SELECT 1 FROM mention_matches mm JOIN project_members pm ON pm.project_id = mm.project_id AND pm.user_id = $2 WHERE mm.mention_id = m.id)`}`,
        all ? [id] : [id, auth.userId])).rows[0];
      if (!r) throw notFound('Mention');
      const duplicates = (await c.query(`SELECT id, title, url, publisher, duplicate_status, duplicate_reason, discovered_at FROM mentions WHERE duplicate_of = $1 ORDER BY discovered_at`, [id])).rows;
      return { ...r, duplicates, dataOrigin: 'live' };
    });
  }
}

@ApiTags('mentions')
@Controller('organizations/:orgId/mentions')
@UseGuards(SessionGuard, TenantGuard)
export class MentionsController {
  constructor(private readonly mentions: MentionsService) {}

  @Get() @RequirePermission('mentions:read')
  search(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Query() q: MentionsQuery) { return this.mentions.search(a, t, q); }

  @Get(':id') @RequirePermission('mentions:read')
  get(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string) { return this.mentions.get(a, t, id); }
}
