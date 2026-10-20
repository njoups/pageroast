import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, Headers, HttpCode, Inject, Injectable, Param, ParseUUIDPipe, Patch, Post, Query, Res, UseGuards, Delete } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import type { Response } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { CLOCK, type Clock } from '../alerts/clock';
import { previousPeriod, isValidTimeZone, nextRunAt, type Frequency } from '../analytics/tz';
import { AuditService } from '../audit/audit.service';
import { SessionGuard } from '../auth/session.guard';
import { RequirePermission, TenantGuard } from '../authz/guards';
import { seesAllProjects } from '../authz/permissions';
import { AppConfig, CONFIG } from '../config';
import { AppError, badRequest, notFound } from '../common/errors';
import { Auth, AuthContext, Meta, RequestMeta, Tenant, TenantContext } from '../common/request';
import { Database } from '../database/database.service';
import { ReportGenerator } from './generator.service';
import { DefinitionSchema, GenerateSchema, ReportParamsSchema, SchedulePatchSchema, ScheduleSchema, zodIssues } from './report-config';
import { ReportsEnqueuer } from './reports-queue';
import { TEMPLATES } from './templates';

const MAX_ACTIVE_SCHEDULES = 20;
const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const r = schema.safeParse(body);
  if (!r.success) throw badRequest('validation_failed', 'Invalid report configuration', zodIssues(r.error));
  return r.data;
};
const tooMany = (msg: string) => new AppError(429, 'quota_exceeded', msg);

class RunsQuery {
  @IsOptional() @IsUUID() definitionId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100_000) offset?: number;
}

@Injectable()
export class ReportsService {
  constructor(private readonly db: Database, private readonly audit: AuditService, private readonly enqueuer: ReportsEnqueuer,
    @Inject(CONFIG) private readonly config: AppConfig, @Inject(CLOCK) private readonly clock: Clock) {}

  /** Project ids the caller may see (owners/admins: all; others: assigned). Report access always follows project access. */
  private async visible(c: PoolClient, auth: AuthContext, t: TenantContext): Promise<string[] | null> {
    if (seesAllProjects(t.role)) return null;
    return (await c.query<{ project_id: string }>('SELECT project_id FROM project_members WHERE user_id = $1', [auth.userId])).rows.map((r) => r.project_id);
  }
  private async requireProject(c: PoolClient, auth: AuthContext, t: TenantContext, projectId: string) {
    const v = await this.visible(c, auth, t);
    const p = (await c.query('SELECT id, name FROM projects WHERE id = $1', [projectId])).rows[0];
    if (!p || (v && !v.includes(projectId))) throw notFound('Project');
    return p;
  }
  private async tz(c: PoolClient, tenantId: string) {
    return ((await c.query<{ tz: string | null }>(`SELECT settings->>'timezone' AS tz FROM tenants WHERE id = $1`, [tenantId])).rows[0]?.tz) || 'Asia/Jakarta';
  }
  private async loadDefinition(c: PoolClient, auth: AuthContext, t: TenantContext, id: string, lock = false) {
    const d = (await c.query(`SELECT d.*, p.name AS project_name FROM report_definitions d JOIN projects p ON p.id = d.project_id WHERE d.id = $1 AND d.deleted_at IS NULL ${lock ? 'FOR UPDATE OF d' : ''}`, [id])).rows[0];
    if (!d) throw notFound('Report definition');
    const v = await this.visible(c, auth, t);
    if (v && !v.includes(d.project_id)) throw notFound('Report definition');
    return d;
  }
  private async validateRefs(c: PoolClient, projectId: string, params: z.infer<typeof ReportParamsSchema>) {
    if (params.entityIds.length) {
      const n = (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM entities WHERE id = ANY($1::uuid[])', [params.entityIds])).rows[0]!.n;
      if (n !== new Set(params.entityIds).size) throw badRequest('validation_failed', 'Unknown entity in entityIds');
    }
    if (params.sourceId && !(await c.query('SELECT 1 FROM sources WHERE id = $1', [params.sourceId])).rowCount) throw badRequest('validation_failed', 'Unknown source');
    if (params.issueId && !(await c.query('SELECT 1 FROM detected_issues WHERE id = $1 AND project_id = $2', [params.issueId, projectId])).rowCount)
      throw badRequest('validation_failed', 'The issue does not belong to this project');
  }
  private defOut(d: Record<string, unknown>) {
    return { id: d.id, projectId: d.project_id, projectName: d.project_name, template: d.template, name: d.name, language: d.language, aiCommentary: d.ai_commentary,
      params: d.params, createdBy: d.created_by, createdAt: d.created_at, updatedAt: d.updated_at };
  }

  templates() {
    return Object.entries(TEMPLATES).map(([key, v]) => ({ key, ...v }));
  }

  listDefinitions(auth: AuthContext, t: TenantContext) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const v = await this.visible(c, auth, t);
      const rows = (await c.query(`SELECT d.*, p.name AS project_name,
          (SELECT row_to_json(x) FROM (SELECT id, status, period_start, period_end, finished_at FROM report_runs r WHERE r.definition_id = d.id ORDER BY queued_at DESC LIMIT 1) x) AS last_run,
          (SELECT count(*)::int FROM report_schedules s WHERE s.definition_id = d.id AND s.is_active) AS active_schedules
        FROM report_definitions d JOIN projects p ON p.id = d.project_id
        WHERE d.deleted_at IS NULL AND ($1::uuid[] IS NULL OR d.project_id = ANY($1::uuid[])) ORDER BY d.updated_at DESC`, [v])).rows;
      return { definitions: rows.map((d) => ({ ...this.defOut(d), lastRun: d.last_run, activeSchedules: d.active_schedules })) };
    });
  }

  getDefinition(auth: AuthContext, t: TenantContext, id: string) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => this.defOut(await this.loadDefinition(c, auth, t, id)));
  }

  createDefinition(auth: AuthContext, t: TenantContext, body: unknown, meta: RequestMeta) {
    const dto = parse(DefinitionSchema, body);
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      await this.requireProject(c, auth, t, dto.projectId);
      await this.validateRefs(c, dto.projectId, dto.params);
      const d = (await c.query(`INSERT INTO report_definitions (tenant_id, project_id, template, name, params, language, ai_commentary, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [t.orgId, dto.projectId, dto.template, dto.name, JSON.stringify(dto.params), dto.language, dto.aiCommentary, auth.userId])).rows[0];
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'report.definition_created', targetType: 'report_definition', targetId: d.id, metadata: { template: dto.template }, meta });
      return this.defOut({ ...d, project_name: null });
    });
  }

  updateDefinition(auth: AuthContext, t: TenantContext, id: string, body: unknown, meta: RequestMeta) {
    const dto = parse(DefinitionSchema.partial().omit({ projectId: true, template: true }).strict(), body);
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const d = await this.loadDefinition(c, auth, t, id, true);
      const params = dto.params ? parse(ReportParamsSchema, { ...(d.params as object), ...dto.params }) : d.params;
      await this.validateRefs(c, d.project_id, params);
      const r = (await c.query(`UPDATE report_definitions SET name = coalesce($2, name), language = coalesce($3, language), ai_commentary = coalesce($4, ai_commentary), params = $5, updated_at = $6
        WHERE id = $1 RETURNING *`, [id, dto.name ?? null, dto.language ?? null, dto.aiCommentary ?? null, JSON.stringify(params), this.clock.now()])).rows[0];
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'report.definition_updated', targetType: 'report_definition', targetId: id, metadata: { fields: Object.keys(dto) }, meta });
      return this.defOut({ ...r, project_name: d.project_name });
    });
  }

  deleteDefinition(auth: AuthContext, t: TenantContext, id: string, meta: RequestMeta) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      await this.loadDefinition(c, auth, t, id, true);
      const now = this.clock.now();
      await c.query('UPDATE report_definitions SET deleted_at = $2 WHERE id = $1', [id, now]);
      await c.query('UPDATE report_schedules SET is_active = false, cancelled_at = coalesce(cancelled_at, $2) WHERE definition_id = $1', [id, now]);
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'report.definition_deleted', targetType: 'report_definition', targetId: id, meta });
    });
  }

  /** Manual generation. Default period: the template's previous complete period in the tenant time zone. */
  async generate(auth: AuthContext, t: TenantContext, id: string, body: unknown, idempotencyKey: string | undefined, meta: RequestMeta) {
    const dto = parse(GenerateSchema, body ?? {});
    if (idempotencyKey && !/^[A-Za-z0-9._:-]{8,100}$/.test(idempotencyKey)) throw badRequest('validation_failed', 'Idempotency-Key must be 8–100 characters [A-Za-z0-9._:-]');
    const out = await this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const d = await this.loadDefinition(c, auth, t, id);
      const tz = await this.tz(c, t.orgId);
      const now = this.clock.now();
      const tpl = TEMPLATES[d.template as keyof typeof TEMPLATES];
      let start: Date; let end: Date;
      if (dto.periodStart || dto.periodEnd) {
        if (!dto.periodStart || !dto.periodEnd) throw badRequest('validation_failed', 'Give both periodStart and periodEnd');
        start = new Date(dto.periodStart); end = new Date(dto.periodEnd);
      } else {
        const p = previousPeriod(tpl.defaultFrequency, now, tz, tpl.defaultPeriodDays); start = p.start; end = p.end;
      }
      if (end <= start) throw badRequest('validation_failed', 'periodEnd must be after periodStart');
      if (end.getTime() - start.getTime() > this.config.analytics.maxPeriodDays * 86_400_000) throw badRequest('period_too_long', `A report may cover at most ${this.config.analytics.maxPeriodDays} days`);
      if (start > now) throw badRequest('validation_failed', 'The period starts in the future');
      const key = `manual:${id}:${idempotencyKey ?? randomUUID()}`;
      const existing = (await c.query('SELECT id, status FROM report_runs WHERE idempotency_key = $1', [key])).rows[0];
      if (existing) return { run: existing, created: false };
      const q = (await c.query<{ today: number; active: number }>(`SELECT count(*) FILTER (WHERE queued_at > $1)::int AS today, count(*) FILTER (WHERE status IN ('queued','running'))::int AS active FROM report_runs`,
        [new Date(now.getTime() - 86_400_000)])).rows[0]!;
      if (q.today >= this.config.reports.runsPerDay) throw tooMany(`Daily report limit (${this.config.reports.runsPerDay}) reached for this organization`);
      if (q.active >= this.config.reports.concurrentRuns) throw tooMany(`At most ${this.config.reports.concurrentRuns} reports can be generated at the same time`);
      const run = (await c.query(`INSERT INTO report_runs (tenant_id, definition_id, template, template_version, period_start, period_end, timezone, idempotency_key, trigger, requested_by, queued_at)
        VALUES ($1,$2,$3,'pending',$4,$5,$6,$7,'manual',$8,$9) RETURNING id, status, period_start, period_end, timezone`, [t.orgId, id, d.template, start, end, tz, key, auth.userId, now])).rows[0];
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'report.generation_requested', targetType: 'report_run', targetId: run.id, metadata: { definitionId: id }, meta });
      return { run, created: true };
    });
    if (out.created) {
      if (!this.enqueuer.available) throw new AppError(503, 'queue_unavailable', 'Report generation needs the worker queue (REDIS_URL); the run stays queued');
      await this.enqueuer.generate(t.orgId, out.run.id);
    }
    return out.run;
  }

  listRuns(auth: AuthContext, t: TenantContext, q: RunsQuery) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const v = await this.visible(c, auth, t);
      const limit = q.limit ?? 25; const offset = q.offset ?? 0;
      const where = `($1::uuid[] IS NULL OR d.project_id = ANY($1::uuid[])) AND ($2::uuid IS NULL OR r.definition_id = $2)`;
      const rows = (await c.query(`SELECT r.id, r.definition_id, d.name, d.template, d.project_id, r.trigger, r.status, r.period_start, r.period_end, r.timezone, r.error, r.ai_method,
          r.queued_at, r.started_at, r.finished_at, r.attempts,
          (SELECT json_agg(json_build_object('format', a.format, 'sizeBytes', a.size_bytes, 'expiresAt', a.expires_at, 'expired', a.data IS NULL)) FROM report_artifacts a WHERE a.run_id = r.id) AS artifacts
        FROM report_runs r JOIN report_definitions d ON d.id = r.definition_id WHERE ${where} ORDER BY r.queued_at DESC LIMIT $3 OFFSET $4`, [v, q.definitionId ?? null, limit, offset])).rows;
      const total = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM report_runs r JOIN report_definitions d ON d.id = r.definition_id WHERE ${where}`, [v, q.definitionId ?? null])).rows[0]!.n;
      return { runs: rows, page: { limit, offset, total } };
    });
  }

  private async loadRun(c: PoolClient, auth: AuthContext, t: TenantContext, id: string) {
    const r = (await c.query(`SELECT r.*, d.name, d.project_id, p.name AS project_name FROM report_runs r JOIN report_definitions d ON d.id = r.definition_id JOIN projects p ON p.id = d.project_id WHERE r.id = $1`, [id])).rows[0];
    const v = await this.visible(c, auth, t);
    if (!r || (v && !v.includes(r.project_id))) throw notFound('Report');
    return r;
  }

  getRun(auth: AuthContext, t: TenantContext, id: string) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const r = await this.loadRun(c, auth, t, id);
      const artifacts = (await c.query(`SELECT format, filename, content_type, size_bytes, sha256, row_count, created_at, expires_at, expired_at, data IS NULL AS expired FROM report_artifacts WHERE run_id = $1 ORDER BY format`, [id])).rows;
      const sources = (await c.query<{ n: number }>('SELECT count(DISTINCT mention_id)::int AS n FROM report_run_sources WHERE run_id = $1', [id])).rows[0]!.n;
      const deliveries = (await c.query(`SELECT channel, kind, status, error, sent_at, read_at FROM report_deliveries WHERE run_id = $1 AND user_id = $2`, [id, auth.userId])).rows;
      await c.query(`UPDATE report_deliveries SET read_at = coalesce(read_at, $3) WHERE run_id = $1 AND user_id = $2 AND channel = 'in_app'`, [id, auth.userId, this.clock.now()]);
      return { id: r.id, definitionId: r.definition_id, name: r.name, projectId: r.project_id, projectName: r.project_name, template: r.template, templateVersion: r.template_version,
        trigger: r.trigger, status: r.status, error: r.error, period: { start: r.period_start, end: r.period_end, timezone: r.timezone },
        queuedAt: r.queued_at, startedAt: r.started_at, finishedAt: r.finished_at, attempts: r.attempts, ai: { method: r.ai_method, tokensIn: r.ai_tokens_in, tokensOut: r.ai_tokens_out },
        model: r.model, freshness: r.freshness, limitations: r.limitations, artifacts, citedSources: sources, myDeliveries: deliveries };
    });
  }

  cancelRun(auth: AuthContext, t: TenantContext, id: string, meta: RequestMeta) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      await this.loadRun(c, auth, t, id);
      const r = await c.query(`UPDATE report_runs SET status = 'cancelled', error = 'Cancelled by a user', finished_at = $2 WHERE id = $1 AND status IN ('queued','running') RETURNING id`, [id, this.clock.now()]);
      if (!r.rowCount) throw new AppError(409, 'not_cancellable', 'Only queued or running reports can be cancelled');
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'report.cancelled', targetType: 'report_run', targetId: id, meta });
      return { id, status: 'cancelled' };
    });
  }

  /** Authenticated download only: tenant (RLS) + project access + reports:read. Never a public or pre-signed URL. */
  async download(auth: AuthContext, t: TenantContext, id: string, format: string, meta: RequestMeta, res: Response) {
    if (format !== 'pdf' && format !== 'csv') throw notFound('Artifact');
    const a = await this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const run = await this.loadRun(c, auth, t, id);
      const art = (await c.query(`SELECT filename, content_type, size_bytes, sha256, data, expires_at FROM report_artifacts WHERE run_id = $1 AND format = $2`, [id, format])).rows[0];
      if (!art) throw notFound('Artifact');
      if (!art.data || art.expires_at <= this.clock.now()) throw new AppError(410, 'artifact_expired', 'This file has expired under the retention policy; generate the report again');
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'report.downloaded', targetType: 'report_run', targetId: id, metadata: { format, projectId: run.project_id }, meta });
      return art;
    });
    res.set({
      'Content-Type': a.content_type, 'Content-Length': String(a.size_bytes), 'Content-Disposition': `attachment; filename="${a.filename}"`,
      'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'X-Checksum-SHA256': a.sha256,
    });
    res.end(a.data);
  }

  inbox(auth: AuthContext, t: TenantContext) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const v = await this.visible(c, auth, t);
      return { deliveries: (await c.query(`SELECT dl.id, dl.run_id, dl.kind, dl.status, dl.created_at, dl.read_at, d.name, r.period_start, r.period_end, r.status AS run_status
        FROM report_deliveries dl JOIN report_runs r ON r.id = dl.run_id JOIN report_definitions d ON d.id = r.definition_id
        WHERE dl.user_id = $1 AND dl.channel = 'in_app' AND dl.status = 'delivered' AND ($2::uuid[] IS NULL OR d.project_id = ANY($2::uuid[])) ORDER BY dl.created_at DESC LIMIT 50`, [auth.userId, v])).rows };
    });
  }

  // ── Schedules ──
  private schedOut(s: Record<string, unknown>) {
    return { id: s.id, definitionId: s.definition_id, frequency: s.frequency, timeOfDay: s.time_of_day, dayOfWeek: s.day_of_week, dayOfMonth: s.day_of_month, periodDays: s.period_days,
      timezone: s.timezone, recipientUserIds: s.recipient_user_ids, channels: s.channels, isActive: s.is_active, nextRunAt: s.next_run_at, lastRunAt: s.last_run_at,
      consecutiveFailures: s.consecutive_failures, cancelledAt: s.cancelled_at, createdBy: s.created_by, createdAt: s.created_at };
  }
  private async checkRecipients(c: PoolClient, projectId: string, ids: string[]) {
    const ok = new Set((await ReportGenerator.authorisedRecipients(c, projectId, ids)).map((u) => u.id));
    const bad = ids.filter((id) => !ok.has(id));
    if (bad.length) throw badRequest('invalid_recipients', 'Recipients must be active members with report access to this project', bad);
  }

  listSchedules(auth: AuthContext, t: TenantContext) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const v = await this.visible(c, auth, t);
      const rows = (await c.query(`SELECT s.*, d.name AS definition_name, d.template FROM report_schedules s JOIN report_definitions d ON d.id = s.definition_id
        WHERE d.deleted_at IS NULL AND ($1::uuid[] IS NULL OR d.project_id = ANY($1::uuid[])) ORDER BY s.created_at DESC`, [v])).rows;
      return { schedules: rows.map((s) => ({ ...this.schedOut(s), definitionName: s.definition_name, template: s.template })) };
    });
  }

  createSchedule(auth: AuthContext, t: TenantContext, body: unknown, meta: RequestMeta) {
    const dto = parse(ScheduleSchema, body);
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const d = await this.loadDefinition(c, auth, t, dto.definitionId);
      const recipients = dto.recipientUserIds.length ? dto.recipientUserIds : [auth.userId];
      await this.checkRecipients(c, d.project_id, recipients);
      const active = (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM report_schedules WHERE is_active')).rows[0]!.n;
      if (dto.isActive && active >= MAX_ACTIVE_SCHEDULES) throw tooMany(`At most ${MAX_ACTIVE_SCHEDULES} active report schedules per organization`);
      const tz = dto.timezone ?? await this.tz(c, t.orgId);
      const next = nextRunAt({ frequency: dto.frequency as Frequency, timeOfDay: dto.timeOfDay, dayOfWeek: dto.dayOfWeek, dayOfMonth: dto.dayOfMonth, periodDays: dto.periodDays, timezone: tz }, this.clock.now());
      const s = (await c.query(`INSERT INTO report_schedules (tenant_id, definition_id, frequency, time_of_day, day_of_week, day_of_month, period_days, timezone, recipient_user_ids, channels, is_active, next_run_at, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [t.orgId, dto.definitionId, dto.frequency, dto.timeOfDay, dto.dayOfWeek, dto.dayOfMonth, dto.periodDays, tz, [...new Set(recipients)], [...new Set(dto.channels)], dto.isActive, next, auth.userId])).rows[0];
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'report.schedule_created', targetType: 'report_schedule', targetId: s.id,
        metadata: { frequency: dto.frequency, recipients: recipients.length, channels: dto.channels }, meta });
      return this.schedOut(s);
    });
  }

  updateSchedule(auth: AuthContext, t: TenantContext, id: string, body: unknown, meta: RequestMeta) {
    const dto = parse(SchedulePatchSchema, body);
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const s = (await c.query('SELECT * FROM report_schedules WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!s) throw notFound('Schedule');
      const d = await this.loadDefinition(c, auth, t, s.definition_id);
      if (s.cancelled_at) throw new AppError(409, 'schedule_cancelled', 'This schedule was cancelled; create a new one');
      const m = { frequency: dto.frequency ?? s.frequency, timeOfDay: dto.timeOfDay ?? s.time_of_day, dayOfWeek: dto.dayOfWeek !== undefined ? dto.dayOfWeek : s.day_of_week,
        dayOfMonth: dto.dayOfMonth !== undefined ? dto.dayOfMonth : s.day_of_month, periodDays: dto.periodDays !== undefined ? dto.periodDays : s.period_days,
        timezone: dto.timezone ?? s.timezone, recipientUserIds: dto.recipientUserIds ?? s.recipient_user_ids, channels: dto.channels ?? s.channels, isActive: dto.isActive ?? s.is_active };
      const checked = parse(ScheduleSchema, { ...m, definitionId: s.definition_id });
      if (!isValidTimeZone(m.timezone)) throw badRequest('validation_failed', 'Unknown time zone');
      if (dto.recipientUserIds) await this.checkRecipients(c, d.project_id, dto.recipientUserIds);
      if (checked.isActive && !s.is_active) {
        const active = (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM report_schedules WHERE is_active')).rows[0]!.n;
        if (active >= MAX_ACTIVE_SCHEDULES) throw tooMany(`At most ${MAX_ACTIVE_SCHEDULES} active report schedules per organization`);
      }
      const next = nextRunAt({ frequency: checked.frequency as Frequency, timeOfDay: checked.timeOfDay, dayOfWeek: checked.dayOfWeek, dayOfMonth: checked.dayOfMonth, periodDays: checked.periodDays, timezone: m.timezone }, this.clock.now());
      const r = (await c.query(`UPDATE report_schedules SET frequency = $2, time_of_day = $3, day_of_week = $4, day_of_month = $5, period_days = $6, timezone = $7, recipient_user_ids = $8, channels = $9,
          is_active = $10, next_run_at = $11, updated_at = $12 WHERE id = $1 RETURNING *`,
        [id, checked.frequency, checked.timeOfDay, checked.dayOfWeek, checked.dayOfMonth, checked.periodDays, m.timezone, [...new Set(checked.recipientUserIds)], [...new Set(checked.channels)], checked.isActive, next, this.clock.now()])).rows[0];
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'report.schedule_updated', targetType: 'report_schedule', targetId: id, metadata: { fields: Object.keys(dto) }, meta });
      return this.schedOut(r);
    });
  }

  cancelSchedule(auth: AuthContext, t: TenantContext, id: string, meta: RequestMeta) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const s = (await c.query('SELECT * FROM report_schedules WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!s) throw notFound('Schedule');
      await this.loadDefinition(c, auth, t, s.definition_id);
      const r = (await c.query(`UPDATE report_schedules SET is_active = false, cancelled_at = coalesce(cancelled_at, $2), updated_at = $2 WHERE id = $1 RETURNING *`, [id, this.clock.now()])).rows[0];
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'report.schedule_cancelled', targetType: 'report_schedule', targetId: id, meta });
      return this.schedOut(r);
    });
  }
}

@ApiTags('reports')
@Controller('organizations/:orgId')
@UseGuards(SessionGuard, TenantGuard)
export class ReportsController {
  constructor(private readonly svc: ReportsService) {}

  @Get('reports/templates') @RequirePermission('reports:read')
  templates() { return { templates: this.svc.templates() }; }
  @Get('reports/definitions') @RequirePermission('reports:read')
  list(@Auth() a: AuthContext, @Tenant() t: TenantContext) { return this.svc.listDefinitions(a, t); }
  @Post('reports/definitions') @RequirePermission('reports:generate')
  create(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Body() b: unknown, @Meta() m: RequestMeta) { return this.svc.createDefinition(a, t, b, m); }
  @Get('reports/definitions/:id') @RequirePermission('reports:read')
  get(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.getDefinition(a, t, id); }
  @Patch('reports/definitions/:id') @RequirePermission('reports:generate')
  update(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown, @Meta() m: RequestMeta) { return this.svc.updateDefinition(a, t, id, b, m); }
  @Delete('reports/definitions/:id') @HttpCode(204) @RequirePermission('reports:generate')
  remove(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Meta() m: RequestMeta) { return this.svc.deleteDefinition(a, t, id, m); }
  @Post('reports/definitions/:id/generate') @HttpCode(202) @RequirePermission('reports:generate')
  generate(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown, @Headers('idempotency-key') key: string | undefined, @Meta() m: RequestMeta) {
    return this.svc.generate(a, t, id, b, key, m);
  }

  @Get('reports/runs') @RequirePermission('reports:read')
  runs(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Query() q: RunsQuery) { return this.svc.listRuns(a, t, q); }
  @Get('reports/runs/:id') @RequirePermission('reports:read')
  run(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.getRun(a, t, id); }
  @Post('reports/runs/:id/cancel') @RequirePermission('reports:generate')
  cancel(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Meta() m: RequestMeta) { return this.svc.cancelRun(a, t, id, m); }
  @Get('reports/runs/:id/download/:format') @RequirePermission('reports:read')
  download(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Param('format') f: string, @Meta() m: RequestMeta, @Res() res: Response) {
    return this.svc.download(a, t, id, f, m, res);
  }
  @Get('reports/inbox') @RequirePermission('reports:read')
  inbox(@Auth() a: AuthContext, @Tenant() t: TenantContext) { return this.svc.inbox(a, t); }

  @Get('report-schedules') @RequirePermission('reports:read')
  schedules(@Auth() a: AuthContext, @Tenant() t: TenantContext) { return this.svc.listSchedules(a, t); }
  @Post('report-schedules') @RequirePermission('reports:generate')
  createSchedule(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Body() b: unknown, @Meta() m: RequestMeta) { return this.svc.createSchedule(a, t, b, m); }
  @Patch('report-schedules/:id') @RequirePermission('reports:generate')
  updateSchedule(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown, @Meta() m: RequestMeta) { return this.svc.updateSchedule(a, t, id, b, m); }
  @Post('report-schedules/:id/cancel') @RequirePermission('reports:generate')
  cancelSchedule(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Meta() m: RequestMeta) { return this.svc.cancelSchedule(a, t, id, m); }
}
