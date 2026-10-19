import { Body, Controller, Delete, Get, HttpCode, Injectable, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { SessionGuard } from '../auth/session.guard';
import { RequirePermission, TenantGuard } from '../authz/guards';
import { Database } from '../database/database.service';
import { badRequest, conflict, notFound } from '../common/errors';
import { Auth, AuthContext, Meta, RequestMeta, Tenant, TenantContext } from '../common/request';
import { ProjectsService } from '../projects/projects.service';
import { IngestionPipeline } from './pipeline.service';
import { compileQuery, parseQuery, QuerySyntaxError } from './query';

const trimArr = ({ value }: { value: unknown }) => (Array.isArray(value) ? value.map((v) => (typeof v === 'string' ? v.trim() : v)).filter((v) => v !== '') : value);
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

class QueryFields {
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MinLength(2) @MaxLength(120) name?: string;
  @ApiPropertyOptional({ description: 'Words or phrases; any one must appear' }) @IsOptional() @Transform(trimArr) @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) @MaxLength(200, { each: true }) keywords?: string[];
  @ApiPropertyOptional({ description: 'Alternative names; treated like keywords' }) @IsOptional() @Transform(trimArr) @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) @MaxLength(200, { each: true }) aliases?: string[];
  @ApiPropertyOptional({ description: 'A record containing any of these is never matched' }) @IsOptional() @Transform(trimArr) @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) @MaxLength(200, { each: true }) exclusions?: string[];
  @ApiPropertyOptional({ description: 'Boolean expression: AND, OR, NOT, "phrases", (groups), prefix*' }) @IsOptional() @IsString() @MaxLength(2000) booleanExpression?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsArray() @ArrayMaxSize(20) @Matches(/^[a-z]{2,3}$/, { each: true }) languages?: string[];
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}
class CreateQueryDto extends QueryFields {
  @ApiProperty() @Transform(trim) @IsString() @MinLength(2) @MaxLength(120) declare name: string;
}
class ValidateExpressionDto {
  @ApiProperty() @IsString() @MaxLength(4000) booleanExpression: string;
}

function compileOrThrow(def: { keywords: string[]; aliases: string[]; exclusions: string[]; booleanExpression: string | null; languages: string[] }) {
  try { compileQuery(def); }
  catch (e) {
    if (e instanceof QuerySyntaxError) throw badRequest('invalid_query', e.message, { position: e.position });
    throw e;
  }
}

const COLS = `q.id, q.project_id, q.name, q.keywords, q.aliases, q.exclusions, q.boolean_expression, q.languages, q.is_active, q.created_at, q.updated_at,
  (SELECT count(*)::int FROM mention_matches mm WHERE mm.query_id = q.id) AS match_count`;

@Injectable()
export class QueriesService {
  constructor(private readonly db: Database, private readonly audit: AuditService, private readonly projects: ProjectsService, private readonly pipeline: IngestionPipeline) {}

  list(auth: AuthContext, t: TenantContext, projectId: string) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      await this.projects.assertVisible(c, auth, t, projectId);
      return (await c.query(`SELECT ${COLS} FROM monitoring_queries q WHERE q.project_id = $1 ORDER BY q.created_at`, [projectId])).rows;
    });
  }

  create(auth: AuthContext, t: TenantContext, projectId: string, dto: CreateQueryDto, meta: RequestMeta) {
    const def = { keywords: dto.keywords ?? [], aliases: dto.aliases ?? [], exclusions: dto.exclusions ?? [], booleanExpression: dto.booleanExpression?.trim() || null, languages: dto.languages ?? [] };
    compileOrThrow(def);
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const p = await this.projects.assertVisible(c, auth, t, projectId, true);
      if (p.status === 'archived') throw conflict('project_archived', 'Unarchive the project before editing its queries');
      const r = await c.query<{ id: string }>(
        `INSERT INTO monitoring_queries (tenant_id, project_id, name, keywords, aliases, exclusions, boolean_expression, languages, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [t.orgId, projectId, dto.name, def.keywords, def.aliases, def.exclusions, def.booleanExpression, def.languages, dto.isActive ?? true]);
      const id = r.rows[0]!.id;
      const matched = await this.pipeline.rematchQuery(c, t.orgId, id);
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'query.created', targetType: 'monitoring_query', targetId: id, metadata: { projectId, name: dto.name }, meta });
      return { ...(await c.query(`SELECT ${COLS} FROM monitoring_queries q WHERE q.id = $1`, [id])).rows[0], rematched: matched };
    });
  }

  update(auth: AuthContext, t: TenantContext, projectId: string, id: string, dto: QueryFields, meta: RequestMeta) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const p = await this.projects.assertVisible(c, auth, t, projectId, true);
      if (p.status === 'archived') throw conflict('project_archived', 'Unarchive the project before editing its queries');
      const cur = (await c.query('SELECT * FROM monitoring_queries WHERE id = $1 AND project_id = $2 FOR UPDATE', [id, projectId])).rows[0];
      if (!cur) throw notFound('Query');
      const def = {
        keywords: dto.keywords ?? cur.keywords, aliases: dto.aliases ?? cur.aliases, exclusions: dto.exclusions ?? cur.exclusions,
        booleanExpression: dto.booleanExpression !== undefined ? dto.booleanExpression?.trim() || null : cur.boolean_expression, languages: dto.languages ?? cur.languages,
      };
      compileOrThrow(def);
      await c.query(
        `UPDATE monitoring_queries SET name = coalesce($2, name), keywords = $3, aliases = $4, exclusions = $5, boolean_expression = $6, languages = $7,
           is_active = coalesce($8, is_active) WHERE id = $1`,
        [id, dto.name ?? null, def.keywords, def.aliases, def.exclusions, def.booleanExpression, def.languages, dto.isActive ?? null]);
      const matched = await this.pipeline.rematchQuery(c, t.orgId, id);
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'query.updated', targetType: 'monitoring_query', targetId: id, metadata: { projectId, fields: Object.keys(dto) }, meta });
      return { ...(await c.query(`SELECT ${COLS} FROM monitoring_queries q WHERE q.id = $1`, [id])).rows[0], rematched: matched };
    });
  }

  remove(auth: AuthContext, t: TenantContext, projectId: string, id: string, meta: RequestMeta) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      await this.projects.assertVisible(c, auth, t, projectId);
      const r = await c.query('DELETE FROM monitoring_queries WHERE id = $1 AND project_id = $2', [id, projectId]);
      if (!r.rowCount) throw notFound('Query');
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'query.deleted', targetType: 'monitoring_query', targetId: id, metadata: { projectId }, meta });
    });
  }
}

@ApiTags('monitoring queries')
@Controller('organizations/:orgId')
@UseGuards(SessionGuard, TenantGuard)
export class QueriesController {
  constructor(private readonly queries: QueriesService) {}

  @Get('projects/:projectId/queries') @RequirePermission('projects:read')
  list(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('projectId', ParseUUIDPipe) p: string) { return this.queries.list(a, t, p); }

  @Post('projects/:projectId/queries') @RequirePermission('projects:update')
  create(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('projectId', ParseUUIDPipe) p: string, @Body() dto: CreateQueryDto, @Meta() m: RequestMeta) {
    return this.queries.create(a, t, p, dto, m);
  }

  @Patch('projects/:projectId/queries/:id') @RequirePermission('projects:update')
  update(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('projectId', ParseUUIDPipe) p: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: QueryFields, @Meta() m: RequestMeta) {
    return this.queries.update(a, t, p, id, dto, m);
  }

  @Delete('projects/:projectId/queries/:id') @HttpCode(204) @RequirePermission('projects:update')
  remove(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('projectId', ParseUUIDPipe) p: string, @Param('id', ParseUUIDPipe) id: string, @Meta() m: RequestMeta) {
    return this.queries.remove(a, t, p, id, m);
  }

  /** Parses without saving, so the UI can show syntax errors with their position. */
  @Post('queries/validate') @HttpCode(200) @RequirePermission('projects:read')
  validate(@Body() dto: ValidateExpressionDto) {
    try { return { valid: true, ast: parseQuery(dto.booleanExpression) }; }
    catch (e) { if (e instanceof QuerySyntaxError) return { valid: false, error: e.message, position: e.position }; throw e; }
  }
}
