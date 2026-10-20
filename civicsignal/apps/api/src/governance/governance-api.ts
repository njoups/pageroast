import { Body, Controller, Delete, Get, HttpCode, Inject, Injectable, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { CLOCK, type Clock } from '../alerts/clock';
import { AuditService } from '../audit/audit.service';
import { SessionGuard } from '../auth/session.guard';
import { RequirePermission, TenantGuard } from '../authz/guards';
import { badRequest, conflict, forbidden, notFound } from '../common/errors';
import { Auth, AuthContext, Meta, RequestMeta, Tenant, TenantContext } from '../common/request';
import { Database } from '../database/database.service';
import { purgeMentions } from './purge';
import { DATA_CLASSES, RetentionService } from './retention.service';

/** Deletion requests resolve to at most this many records; larger scopes must be split (or use retention). */
export const MAX_DELETION_RECORDS = 20_000;

const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const r = schema.safeParse(body);
  if (!r.success) throw badRequest('validation_failed', 'Invalid request', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  return r.data;
};
const ControlsSchema = z.object({
  retentionEnabled: z.boolean().optional(),
  legalHold: z.boolean().optional(),
  legalHoldReason: z.string().trim().max(500).nullable().optional(),
}).strict();
const PolicySchema = z.object({ retentionDays: z.number().int().min(1).max(36_500) }).strict();
const DeletionSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('mentions'), mentionIds: z.array(z.string().uuid()).min(1).max(1000), reason: z.string().trim().min(5).max(1000) }).strict(),
  z.object({ scope: z.literal('source'), sourceId: z.string().uuid(), reason: z.string().trim().min(5).max(1000) }).strict(),
  z.object({ scope: z.literal('search'), query: z.string().trim().min(3).max(200), reason: z.string().trim().min(5).max(1000) }).strict(),
]);
const ReviewSchema = z.object({ note: z.string().trim().max(1000).optional(), confirmSelfApproval: z.boolean().optional() }).strict();

@Injectable()
export class GovernanceService {
  constructor(private readonly db: Database, private readonly audit: AuditService, private readonly retention: RetentionService, @Inject(CLOCK) private readonly clock: Clock) {}

  private async controls(c: PoolClient, tenantId: string) {
    return (await c.query('SELECT legal_hold, legal_hold_reason, retention_enabled, updated_by, updated_at FROM tenant_data_controls WHERE tenant_id = $1', [tenantId])).rows[0]
      ?? { legal_hold: false, legal_hold_reason: null, retention_enabled: false, updated_by: null, updated_at: null };
  }

  overview(auth: AuthContext, t: TenantContext) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => ({
      controls: await this.controls(c, t.orgId),
      policies: (await c.query('SELECT data_class, retention_days, updated_by, updated_at FROM retention_policies ORDER BY data_class')).rows,
      dataClasses: DATA_CLASSES,
      runs: (await c.query('SELECT id, trigger, dry_run, status, counts, error, started_at, finished_at FROM retention_runs ORDER BY started_at DESC LIMIT 20')).rows,
      notes: [
        'Retention deletes nothing until it is enabled. A legal hold suspends retention and deletion requests.',
        'Audit events are append-only and never deleted by the application; past-retention counts are reported for operators.',
        'Deletion removes data from the live database. Copies in backups expire with the backup retention period (docs/BACKUP_AND_RECOVERY.md).',
      ],
    }));
  }

  updateControls(auth: AuthContext, t: TenantContext, body: unknown, meta: RequestMeta) {
    const dto = parse(ControlsSchema, body);
    if (dto.legalHold === true && !dto.legalHoldReason) throw badRequest('validation_failed', 'A legal hold needs a reason');
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const cur = await this.controls(c, t.orgId);
      const r = (await c.query(`INSERT INTO tenant_data_controls (tenant_id, legal_hold, legal_hold_reason, retention_enabled, updated_by, updated_at)
        VALUES ($1, coalesce($2, false), $3, coalesce($4, false), $5, $6)
        ON CONFLICT (tenant_id) DO UPDATE SET legal_hold = coalesce($2, tenant_data_controls.legal_hold),
          legal_hold_reason = CASE WHEN $2 IS FALSE THEN NULL WHEN $3 IS NOT NULL THEN $3 ELSE tenant_data_controls.legal_hold_reason END,
          retention_enabled = coalesce($4, tenant_data_controls.retention_enabled), updated_by = $5, updated_at = $6
        RETURNING legal_hold, legal_hold_reason, retention_enabled, updated_at`,
        [t.orgId, dto.legalHold ?? null, dto.legalHoldReason ?? null, dto.retentionEnabled ?? null, auth.userId, this.clock.now()])).rows[0];
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'data_controls.updated', targetType: 'tenant', targetId: t.orgId,
        metadata: { before: { legalHold: cur.legal_hold, retentionEnabled: cur.retention_enabled }, after: { legalHold: r.legal_hold, retentionEnabled: r.retention_enabled } }, meta });
      return r;
    });
  }

  setPolicy(auth: AuthContext, t: TenantContext, dataClass: string, body: unknown, meta: RequestMeta) {
    if (!(DATA_CLASSES as readonly string[]).includes(dataClass)) throw notFound('Data class');
    const dto = parse(PolicySchema, body);
    if (dataClass === 'audit_events' && dto.retentionDays < 365) throw badRequest('validation_failed', 'Audit events must be kept at least 365 days');
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const before = (await c.query('SELECT retention_days FROM retention_policies WHERE data_class = $1', [dataClass])).rows[0]?.retention_days ?? null;
      const r = (await c.query(`INSERT INTO retention_policies (tenant_id, data_class, retention_days, updated_by, updated_at) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (tenant_id, data_class) DO UPDATE SET retention_days = $3, updated_by = $4, updated_at = $5 RETURNING data_class, retention_days, updated_at`,
        [t.orgId, dataClass, dto.retentionDays, auth.userId, this.clock.now()])).rows[0];
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'retention.policy_set', targetType: 'retention_policy', targetId: dataClass,
        metadata: { before, after: dto.retentionDays }, meta });
      return r;
    });
  }

  removePolicy(auth: AuthContext, t: TenantContext, dataClass: string, meta: RequestMeta) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const r = await c.query('DELETE FROM retention_policies WHERE data_class = $1 RETURNING retention_days', [dataClass]);
      if (!r.rowCount) throw notFound('Retention policy');
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'retention.policy_removed', targetType: 'retention_policy', targetId: dataClass,
        metadata: { before: r.rows[0].retention_days }, meta });
    });
  }

  preview(auth: AuthContext, t: TenantContext) { return this.retention.run(t.orgId, { dryRun: true, trigger: 'manual', userId: auth.userId }); }
  apply(auth: AuthContext, t: TenantContext) { return this.retention.run(t.orgId, { dryRun: false, trigger: 'manual', userId: auth.userId }); }

  // ── Deletion requests ──
  private async resolve(c: PoolClient, scope: string, criteria: Record<string, unknown>): Promise<string[]> {
    let rows: Array<{ id: string }>;
    if (scope === 'mentions') rows = (await c.query('SELECT id FROM mentions WHERE id = ANY($1::uuid[])', [criteria.mentionIds])).rows;
    else if (scope === 'source') {
      if (!(await c.query('SELECT 1 FROM sources WHERE id = $1', [criteria.sourceId])).rowCount) throw notFound('Source');
      rows = (await c.query(`SELECT id FROM mentions WHERE source_id = $1 LIMIT ${MAX_DELETION_RECORDS + 1}`, [criteria.sourceId])).rows;
    } else {
      // Locates records containing a name or phrase anywhere stored: headline, excerpt, publisher (full-text) or body (substring).
      const q = String(criteria.query);
      const like = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
      rows = (await c.query(`SELECT id FROM mentions WHERE search_tsv @@ websearch_to_tsquery('simple', $1) OR title ILIKE $2 OR excerpt ILIKE $2 OR body ILIKE $2
        LIMIT ${MAX_DELETION_RECORDS + 1}`, [q, like])).rows;
    }
    if (rows.length > MAX_DELETION_RECORDS) throw badRequest('scope_too_large', `The request matches more than ${MAX_DELETION_RECORDS} records; narrow it or split it`);
    return rows.map((r) => r.id);
  }

  private async preview_(c: PoolClient, ids: string[]) {
    const one = async (sql: string) => (await c.query<{ n: number }>(sql, [ids])).rows[0]!.n;
    return {
      mentions: ids.length,
      mention_matches: await one('SELECT count(*)::int AS n FROM mention_matches WHERE mention_id = ANY($1::uuid[])'),
      analyses: await one('SELECT count(*)::int AS n FROM mention_analyses WHERE mention_id = ANY($1::uuid[])'),
      alert_evidence: await one('SELECT count(*)::int AS n FROM alert_evidence WHERE mention_id = ANY($1::uuid[])'),
      open_issue_evidence: await one(`SELECT count(*)::int AS n FROM alert_evidence e JOIN detected_issues i ON i.id = e.issue_id WHERE e.mention_id = ANY($1::uuid[]) AND i.status NOT IN ('resolved','closed')`),
      report_runs_citing: await one('SELECT count(DISTINCT run_id)::int AS n FROM report_run_sources WHERE mention_id = ANY($1::uuid[])'),
      summaries_citing: await one('SELECT count(*)::int AS n FROM ai_summaries WHERE supporting_mention_ids && $1::uuid[] OR mention_id = ANY($1::uuid[])'),
      story_clusters: await one('SELECT count(DISTINCT cluster_id)::int AS n FROM cluster_members WHERE mention_id = ANY($1::uuid[])'),
      sample: (await c.query('SELECT id, title, publisher_domain, discovered_at FROM mentions WHERE id = ANY($1::uuid[]) ORDER BY discovered_at DESC LIMIT 20', [ids])).rows,
    };
  }

  private async assertNoHold(c: PoolClient, tenantId: string) {
    if ((await this.controls(c, tenantId)).legal_hold) throw conflict('legal_hold', 'A legal hold is active; deletion is suspended until it is lifted');
  }

  createDeletion(auth: AuthContext, t: TenantContext, body: unknown, meta: RequestMeta) {
    const dto = parse(DeletionSchema, body);
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      await this.assertNoHold(c, t.orgId);
      const { reason, scope, ...criteria } = dto;
      const ids = await this.resolve(c, scope, criteria);
      if (!ids.length) throw badRequest('nothing_matched', 'No stored records match this request');
      const preview = await this.preview_(c, ids);
      const r = (await c.query(`INSERT INTO deletion_requests (tenant_id, scope, criteria, reason, preview, requested_by, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, status, created_at`,
        [t.orgId, scope, JSON.stringify({ ...criteria, resolvedMentionIds: ids }), reason, JSON.stringify(preview), auth.userId, this.clock.now()])).rows[0];
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'deletion.requested', targetType: 'deletion_request', targetId: r.id,
        metadata: { scope, records: ids.length }, meta });
      return { ...r, preview };
    });
  }

  listDeletions(auth: AuthContext, t: TenantContext) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => ({ requests: (await c.query(`SELECT id, scope, reason, status, preview - 'sample' AS preview, result, requested_by, reviewed_by,
      review_note, error, created_at, reviewed_at, completed_at FROM deletion_requests ORDER BY created_at DESC LIMIT 100`)).rows }));
  }

  getDeletion(auth: AuthContext, t: TenantContext, id: string) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const r = (await c.query(`SELECT id, scope, criteria - 'resolvedMentionIds' AS criteria, reason, status, preview, result, requested_by, reviewed_by, review_note, error,
        created_at, reviewed_at, completed_at FROM deletion_requests WHERE id = $1`, [id])).rows[0];
      if (!r) throw notFound('Deletion request');
      return r;
    });
  }

  /**
   * Approval executes the deletion. A second person with `data:delete` must approve; an organization with a single owner
   * may self-approve only with explicit confirmation (recorded). Re-resolved ids are intersected with the request's
   * snapshot, so a request never grows beyond what was reviewed.
   */
  async approveDeletion(auth: AuthContext, t: TenantContext, id: string, body: unknown, meta: RequestMeta) {
    const dto = parse(ReviewSchema, body ?? {});
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const r = (await c.query('SELECT * FROM deletion_requests WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!r) throw notFound('Deletion request');
      if (r.status !== 'pending_review') throw conflict('not_pending', `This request is ${r.status}`);
      await this.assertNoHold(c, t.orgId);
      if (r.requested_by === auth.userId) {
        const owners = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM memberships WHERE role = 'owner'`)).rows[0]!.n;
        if (owners > 1) throw forbidden('Another owner must approve this deletion (four-eyes rule)');
        if (!dto.confirmSelfApproval) throw badRequest('confirmation_required', 'You are the only owner: confirm self-approval explicitly (confirmSelfApproval: true)');
      }
      const snapshot: string[] = r.criteria.resolvedMentionIds ?? [];
      const now = this.clock.now();
      await c.query(`UPDATE deletion_requests SET status = 'running', reviewed_by = $2, reviewed_at = $3, review_note = $4 WHERE id = $1`, [id, auth.userId, now, dto.note ?? null]);
      const current = new Set(await this.resolve(c, r.scope, r.criteria).catch(() => [] as string[]));
      const ids = snapshot.filter((x) => current.has(x));
      const result: Record<string, number> = {};
      for (let i = 0; i < ids.length; i += 1000) {
        const part = await purgeMentions(c, ids.slice(i, i + 1000), now, `deletion request ${id}`);
        for (const [k, v] of Object.entries(part)) result[k] = (result[k] ?? 0) + v;
      }
      await c.query(`UPDATE deletion_requests SET status = 'completed', result = $2, completed_at = $3 WHERE id = $1`, [id, JSON.stringify(result), this.clock.now()]);
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'deletion.completed', targetType: 'deletion_request', targetId: id,
        metadata: { scope: r.scope, result, selfApproved: r.requested_by === auth.userId }, meta });
      return { id, status: 'completed', result };
    });
  }

  rejectOrCancel(auth: AuthContext, t: TenantContext, id: string, action: 'reject' | 'cancel', body: unknown, meta: RequestMeta) {
    const dto = parse(ReviewSchema, body ?? {});
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const r = (await c.query('SELECT status, requested_by FROM deletion_requests WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!r) throw notFound('Deletion request');
      if (r.status !== 'pending_review') throw conflict('not_pending', `This request is ${r.status}`);
      if (action === 'cancel' && r.requested_by !== auth.userId) throw forbidden('Only the requester can cancel; others reject');
      const status = action === 'reject' ? 'rejected' : 'cancelled';
      await c.query('UPDATE deletion_requests SET status = $2, reviewed_by = $3, reviewed_at = $4, review_note = $5 WHERE id = $1', [id, status, auth.userId, this.clock.now(), dto.note ?? null]);
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: `deletion.${status}`, targetType: 'deletion_request', targetId: id, meta });
      return { id, status };
    });
  }
}

@ApiTags('governance')
@Controller('organizations/:orgId')
@UseGuards(SessionGuard, TenantGuard)
export class GovernanceController {
  constructor(private readonly svc: GovernanceService) {}

  @Get('data-governance') @RequirePermission('retention:manage')
  overview(@Auth() a: AuthContext, @Tenant() t: TenantContext) { return this.svc.overview(a, t); }
  @Put('data-governance/controls') @RequirePermission('retention:manage')
  controls(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Body() b: unknown, @Meta() m: RequestMeta) { return this.svc.updateControls(a, t, b, m); }
  @Put('data-governance/retention-policies/:dataClass') @RequirePermission('retention:manage')
  setPolicy(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('dataClass') d: string, @Body() b: unknown, @Meta() m: RequestMeta) { return this.svc.setPolicy(a, t, d, b, m); }
  @Delete('data-governance/retention-policies/:dataClass') @HttpCode(204) @RequirePermission('retention:manage')
  removePolicy(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('dataClass') d: string, @Meta() m: RequestMeta) { return this.svc.removePolicy(a, t, d, m); }
  @Post('data-governance/retention/preview') @HttpCode(200) @RequirePermission('retention:manage')
  preview(@Auth() a: AuthContext, @Tenant() t: TenantContext) { return this.svc.preview(a, t); }
  @Post('data-governance/retention/apply') @HttpCode(200) @RequirePermission('data:delete')
  apply(@Auth() a: AuthContext, @Tenant() t: TenantContext) { return this.svc.apply(a, t); }

  @Get('deletion-requests') @RequirePermission('data:delete')
  deletions(@Auth() a: AuthContext, @Tenant() t: TenantContext) { return this.svc.listDeletions(a, t); }
  @Post('deletion-requests') @RequirePermission('data:delete')
  createDeletion(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Body() b: unknown, @Meta() m: RequestMeta) { return this.svc.createDeletion(a, t, b, m); }
  @Get('deletion-requests/:id') @RequirePermission('data:delete')
  deletion(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.getDeletion(a, t, id); }
  @Post('deletion-requests/:id/approve') @HttpCode(200) @RequirePermission('data:delete')
  approve(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown, @Meta() m: RequestMeta) { return this.svc.approveDeletion(a, t, id, b, m); }
  @Post('deletion-requests/:id/reject') @HttpCode(200) @RequirePermission('data:delete')
  reject(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown, @Meta() m: RequestMeta) { return this.svc.rejectOrCancel(a, t, id, 'reject', b, m); }
  @Post('deletion-requests/:id/cancel') @HttpCode(200) @RequirePermission('data:delete')
  cancel(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown, @Meta() m: RequestMeta) { return this.svc.rejectOrCancel(a, t, id, 'cancel', b, m); }
}

