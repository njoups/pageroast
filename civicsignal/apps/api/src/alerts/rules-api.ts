import { Body, Controller, Delete, Get, HttpCode, Inject, Injectable, Param, ParseUUIDPipe, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateIf, ValidateNested } from 'class-validator';
import type { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import { SessionGuard } from '../auth/session.guard';
import { RequirePermission, TenantGuard } from '../authz/guards';
import { hasPermission, seesAllProjects, type Role } from '../authz/permissions';
import { AppError, badRequest, conflict, notFound } from '../common/errors';
import { Auth, AuthContext, Meta, RequestMeta, Tenant, TenantContext } from '../common/request';
import { AppConfig, CONFIG } from '../config';
import { Database } from '../database/database.service';
import { REDIS } from '../ingestion/ingestion-core.module';
import { KEY_PREFIX, type Redis } from '../ingestion/queue';
import { SafeHttpClient } from '../ingestion/safe-http';
import { ProjectsService } from '../projects/projects.service';
import { AlertsEnqueuer } from './alerts-queue';
import { assertWebhookUrl, newWebhookSecret, signWebhook } from './channels/webhook';
import { CLOCK, type Clock } from './clock';
import { EvaluatorService, type RuleRow } from './evaluator.service';
import { SEVERITIES } from './levels';
import { NotificationService } from './notifications.service';
import { configSha, referencedIds, RULE_TYPES, RuleConfigError, validateRuleConfig, type RuleType } from './rule-config';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

class CreateRuleDto {
  @IsUUID() projectId: string;
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(120) name: string;
  @IsIn(RULE_TYPES) ruleType: RuleType;
  @IsOptional() @IsObject() config?: Record<string, unknown>;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsUUID() ownerUserId?: string;
}
class UpdateRuleDto {
  @IsOptional() @Transform(trim) @IsString() @MinLength(2) @MaxLength(120) name?: string;
  @IsOptional() @IsObject() config?: Record<string, unknown>;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsUUID() ownerUserId?: string | null;
}
class PreviewDto { @IsUUID() projectId: string; @IsIn(RULE_TYPES) ruleType: RuleType; @IsOptional() @IsObject() config?: Record<string, unknown> }
class RuleListQuery { @IsOptional() @IsUUID() projectId?: string; @IsOptional() @IsIn(['true', 'false']) includeDeleted?: string }

class WebhookDto {
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(80) name: string;
  @Transform(trim) @IsString() @MaxLength(2000) url: string;
  @IsOptional() @IsIn(SEVERITIES) minSeverity?: string;
}
class WebhookUpdateDto { @IsOptional() @Transform(trim) @IsString() @MinLength(2) @MaxLength(80) name?: string; @IsOptional() @IsIn(SEVERITIES) minSeverity?: string; @IsOptional() @IsBoolean() isActive?: boolean }
class RotateDto { @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(168) graceHours?: number }

class PreferenceItem {
  @IsIn(['in_app', 'email', 'whatsapp']) channel: 'in_app' | 'email' | 'whatsapp';
  @IsBoolean() enabled: boolean;
  @IsIn(SEVERITIES) minSeverity: string;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @Matches(/^\+[1-9]\d{7,14}$/, { message: 'destination must be an E.164 phone number (e.g. +6281234567890)' }) destination?: string | null;
}
class PreferencesDto { @IsArray() @ArrayMaxSize(3) @ValidateNested({ each: true }) @Type(() => PreferenceItem) items: PreferenceItem[] }
class InboxQuery { @IsOptional() @IsIn(['true', 'false']) unread?: string; @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number }
class ReadDto { @IsBoolean() read: boolean }

@Injectable()
export class RulesService {
  private readonly http: SafeHttpClient;
  constructor(private readonly db: Database, private readonly audit: AuditService, private readonly projects: ProjectsService, private readonly evaluator: EvaluatorService,
    private readonly notifications: NotificationService, private readonly enqueuer: AlertsEnqueuer, @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock, @Inject(REDIS) private readonly redis: Redis | null) {
    this.http = new SafeHttpClient({ userAgent: 'CivicSignal-Webhooks/1', allowPrivateHosts: config.ingestion.allowPrivateHosts, timeoutMs: config.alerts.webhookTimeoutMs, maxBytes: 64 * 1024, maxRedirects: 0 });
  }

  private async rateLimit(key: string, limit: number) {
    if (!this.redis) return;
    const k = `${KEY_PREFIX}:alerts:api:${key}:${Math.floor(Date.now() / 60_000)}`;
    const n = await this.redis.incr(k); if (n === 1) await this.redis.expire(k, 120);
    if (n > limit) throw new AppError(429, 'rate_limited', `Limited to ${limit} requests per minute for this organization`);
  }

  /** Validates config and that every referenced id belongs to this tenant (and users can see the project). */
  private async validate(c: PoolClient, type: RuleType, projectId: string, input: unknown) {
    let cfg;
    try { cfg = validateRuleConfig(type, input); } catch (e) {
      if (e instanceof RuleConfigError) throw badRequest('validation_failed', 'Invalid alert rule configuration', e.problems);
      throw e;
    }
    const ids = referencedIds(cfg);
    const problems: Array<{ field: string; problems: string[] }> = [];
    const count = async (sql: string, list: string[]) => list.length ? (await c.query<{ n: number }>(sql, [list])).rows[0]!.n : 0;
    if (await count('SELECT count(*)::int AS n FROM entities WHERE id = ANY($1::uuid[])', ids.entityIds) !== ids.entityIds.length) problems.push({ field: 'filters.entityIds', problems: ['Unknown entity'] });
    if (await count('SELECT count(*)::int AS n FROM sources WHERE id = ANY($1::uuid[])', ids.sourceIds) !== ids.sourceIds.length) problems.push({ field: 'filters.sourceIds', problems: ['Unknown source'] });
    if (await count('SELECT count(*)::int AS n FROM webhook_endpoints WHERE id = ANY($1::uuid[])', ids.webhookEndpointIds) !== ids.webhookEndpointIds.length) problems.push({ field: 'notify.webhookEndpointIds', problems: ['Unknown webhook endpoint'] });
    const custom = cfg.filters.topics.filter((t) => t.startsWith('custom:'));
    if (custom.length && (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM project_topics WHERE project_id = $1 AND key = ANY($2::text[])', [projectId, custom])).rows[0]!.n !== custom.length) {
      problems.push({ field: 'filters.topics', problems: ['Unknown project topic category'] });
    }
    if (ids.userIds.length) {
      const m = (await c.query<{ user_id: string; role: Role; assigned: boolean }>(`SELECT m.user_id, m.role, EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = $2 AND pm.user_id = m.user_id) AS assigned
        FROM memberships m WHERE m.user_id = ANY($1::uuid[])`, [ids.userIds, projectId])).rows;
      const ok = new Set(m.filter((x) => hasPermission(x.role, 'alerts:read') && (seesAllProjects(x.role) || x.assigned)).map((x) => x.user_id));
      if (ids.userIds.some((u) => !ok.has(u))) problems.push({ field: 'notify.recipientUserIds', problems: ['Recipients must be members who can see this project\'s issues'] });
    }
    if (problems.length) throw badRequest('validation_failed', 'Invalid alert rule configuration', problems);
    return cfg;
  }

  private readonly ruleCols = `r.id, r.project_id, p.name AS project_name, r.name, r.rule_type, r.is_active, r.current_version, r.owner_user_id, u.display_name AS owner_name,
    r.created_by, r.created_at, r.updated_at, r.deleted_at, v.config,
    (SELECT count(*)::int FROM detected_issues i WHERE i.rule_id = r.id AND i.status NOT IN ('resolved','closed')) AS open_issues,
    (SELECT max(i.last_detected_at) FROM detected_issues i WHERE i.rule_id = r.id) AS last_triggered_at`;

  list(auth: AuthContext, t: TenantContext, q: RuleListQuery) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => (await c.query(
      `SELECT ${this.ruleCols} FROM alert_rules r JOIN projects p ON p.id = r.project_id JOIN alert_rule_versions v ON v.rule_id = r.id AND v.version = r.current_version
       LEFT JOIN users u ON u.id = r.owner_user_id
       WHERE ($1::uuid IS NULL OR r.project_id = $1) AND ($2 OR r.deleted_at IS NULL)
         AND ($3 OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = r.project_id AND pm.user_id = $4))
       ORDER BY r.deleted_at NULLS FIRST, r.created_at DESC`, [q.projectId ?? null, q.includeDeleted === 'true', seesAllProjects(t.role), auth.userId])).rows);
  }

  private async loadRule(c: PoolClient, auth: AuthContext, t: TenantContext, id: string, lock = false) {
    const r = (await c.query<{ id: string; project_id: string; rule_type: RuleType; current_version: number; deleted_at: Date | null; name: string; is_active: boolean }>(
      `SELECT r.* FROM alert_rules r WHERE r.id = $1 ${lock ? 'FOR UPDATE' : ''}`, [id])).rows[0];
    if (!r) throw notFound('Alert rule');
    await this.projects.assertVisible(c, auth, t, r.project_id);
    return r;
  }

  get(auth: AuthContext, t: TenantContext, id: string) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      await this.loadRule(c, auth, t, id);
      const rule = (await c.query(`SELECT ${this.ruleCols} FROM alert_rules r JOIN projects p ON p.id = r.project_id JOIN alert_rule_versions v ON v.rule_id = r.id AND v.version = r.current_version
        LEFT JOIN users u ON u.id = r.owner_user_id WHERE r.id = $1`, [id])).rows[0];
      const versions = (await c.query(`SELECT v.version, v.config, v.config_sha256, v.created_at, u.display_name AS created_by_name FROM alert_rule_versions v
        LEFT JOIN users u ON u.id = v.created_by WHERE v.rule_id = $1 ORDER BY v.version DESC`, [id])).rows;
      return { ...rule, versions };
    });
  }

  create(auth: AuthContext, t: TenantContext, dto: CreateRuleDto, meta: RequestMeta) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const p = await this.projects.assertVisible(c, auth, t, dto.projectId, true);
      if (p.status === 'archived') throw conflict('project_archived', 'Unarchive the project first');
      const cfg = await this.validate(c, dto.ruleType, dto.projectId, dto.config ?? {});
      const owner = dto.ownerUserId ?? auth.userId;
      if (dto.ownerUserId) await this.assertOwner(c, dto.projectId, dto.ownerUserId);
      const r = (await c.query<{ id: string }>(`INSERT INTO alert_rules (tenant_id, project_id, name, rule_type, is_active, owner_user_id, created_by, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING id`, [t.orgId, dto.projectId, dto.name, dto.ruleType, dto.isActive ?? true, owner, auth.userId, this.clock.now()])).rows[0]!;
      await c.query(`INSERT INTO alert_rule_versions (tenant_id, rule_id, version, config, config_sha256, created_by, created_at) VALUES ($1,$2,1,$3,$4,$5,$6)`,
        [t.orgId, r.id, JSON.stringify(cfg), configSha(cfg), auth.userId, this.clock.now()]);
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'alert_rule.created', targetType: 'alert_rule', targetId: r.id, metadata: { name: dto.name, ruleType: dto.ruleType, projectId: dto.projectId }, meta });
      return { id: r.id, version: 1, config: cfg };
    });
  }

  /** A rule owner must be a member who can read alerts and can see the rule's project. */
  private async assertOwner(c: import('pg').PoolClient, projectId: string, userId: string) {
    const m = (await c.query<{ role: Role; assigned: boolean }>(`SELECT role, EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = $2 AND pm.user_id = $1) AS assigned
      FROM memberships WHERE user_id = $1`, [userId, projectId])).rows[0];
    if (!m || !hasPermission(m.role, 'alerts:read') || !(seesAllProjects(m.role) || m.assigned)) {
      throw badRequest('validation_failed', 'Owner must be a member who can read alerts in this project');
    }
  }

  /** Name/owner/active changes update the rule; any config change creates a new immutable version. */
  update(auth: AuthContext, t: TenantContext, id: string, dto: UpdateRuleDto, meta: RequestMeta) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const r = await this.loadRule(c, auth, t, id, true);
      if (r.deleted_at) throw conflict('rule_deleted', 'Deleted rules cannot be edited');
      let version = r.current_version;
      if (dto.config) {
        const cfg = await this.validate(c, r.rule_type, r.project_id, dto.config);
        const cur = (await c.query<{ config_sha256: string }>('SELECT config_sha256 FROM alert_rule_versions WHERE rule_id = $1 AND version = $2', [id, version])).rows[0]!;
        if (cur.config_sha256 !== configSha(cfg)) {
          version++;
          await c.query(`INSERT INTO alert_rule_versions (tenant_id, rule_id, version, config, config_sha256, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [t.orgId, id, version, JSON.stringify(cfg), configSha(cfg), auth.userId, this.clock.now()]);
        }
      }
      if (dto.ownerUserId) await this.assertOwner(c, r.project_id, dto.ownerUserId);
      await c.query(`UPDATE alert_rules SET name = coalesce($2, name), is_active = coalesce($3, is_active), owner_user_id = CASE WHEN $4 THEN $5::uuid ELSE owner_user_id END,
        current_version = $6, updated_at = $7 WHERE id = $1`, [id, dto.name ?? null, dto.isActive ?? null, dto.ownerUserId !== undefined, dto.ownerUserId ?? null, version, this.clock.now()]);
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'alert_rule.updated', targetType: 'alert_rule', targetId: id,
        metadata: { version, newVersion: version !== r.current_version, isActive: dto.isActive, name: dto.name }, meta });
      return { id, version };
    });
  }

  /** Soft delete: the rule stops evaluating; its versions and issues remain explainable. */
  remove(auth: AuthContext, t: TenantContext, id: string, meta: RequestMeta) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const r = await this.loadRule(c, auth, t, id, true);
      if (r.deleted_at) return;
      await c.query('UPDATE alert_rules SET deleted_at = $2, is_active = false, updated_at = $2 WHERE id = $1', [id, this.clock.now()]);
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'alert_rule.deleted', targetType: 'alert_rule', targetId: id, metadata: { name: r.name }, meta });
    });
  }

  private summarise(results: Awaited<ReturnType<EvaluatorService['assess']>>) {
    return results.map(({ candidate, severity }) => ({
      signal: candidate.signal, scope: candidate.scope, subject: `${candidate.subjectType}:${candidate.subjectKey}`, title: candidate.title,
      triggered: candidate.result.triggered, suppressed: candidate.result.suppressed, severity: candidate.result.triggered ? severity : null,
      method: candidate.result.method, observed: candidate.result.observed, baseline: candidate.result.baseline, thresholds: candidate.result.thresholds,
      exceeded: candidate.result.exceeded, limitations: candidate.result.limitations, evidence: candidate.evidence.slice(0, 20).map((r) => r.id), evidenceCount: candidate.evidence.length,
    }));
  }

  /** Dry run of a saved rule against current data. Creates nothing, sends nothing. */
  async test(auth: AuthContext, t: TenantContext, id: string, meta: RequestMeta) {
    await this.rateLimit(`test:${t.orgId}`, 10);
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      await this.loadRule(c, auth, t, id);
      const [rule] = await this.evaluator.activeRules(c, id);
      if (!rule) throw notFound('Alert rule');
      const res = await this.evaluator.assess(c, rule, this.clock.now());
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'alert_rule.tested', targetType: 'alert_rule', targetId: id, metadata: { candidates: res.length }, meta });
      return { dryRun: true, evaluatedAt: this.clock.now(), ruleVersion: rule.current_version, results: this.summarise(res) };
    });
  }

  /** Dry run of an unsaved configuration (rule form preview). */
  async preview(auth: AuthContext, t: TenantContext, dto: PreviewDto) {
    await this.rateLimit(`test:${t.orgId}`, 10);
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      await this.projects.assertVisible(c, auth, t, dto.projectId);
      const cfg = await this.validate(c, dto.ruleType, dto.projectId, dto.config ?? {});
      const rule: RuleRow = { id: '00000000-0000-0000-0000-000000000000', project_id: dto.projectId, name: 'preview', rule_type: dto.ruleType, current_version: 0, owner_user_id: auth.userId, config: cfg };
      return { dryRun: true, evaluatedAt: this.clock.now(), config: cfg, results: this.summarise(await this.evaluator.assess(c, rule, this.clock.now())) };
    });
  }

  /** Queues an evaluation now (subject to the per-bucket idempotency key). */
  async evaluateNow(auth: AuthContext, t: TenantContext, meta: RequestMeta) {
    if (!this.enqueuer.available) throw new AppError(503, 'queue_unavailable', 'The alert queue (Redis) is not configured on this server');
    await this.rateLimit(`evaluate:${t.orgId}`, 5);
    await this.enqueuer.evaluate(t.orgId, 'manual');
    await this.db.withTenant(t.orgId, auth.userId, (c) => this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'alerts.evaluation_requested', meta }));
    return { status: 'queued' };
  }

  // ── Webhooks ──────────────────────────────────────────────────────────────────────────────────────
  private cipher() {
    if (!this.notifications.cipher) throw new AppError(503, 'credentials_key_missing', 'Webhooks need CREDENTIALS_KEY to store signing secrets (docs/NOTIFICATIONS.md)');
    return this.notifications.cipher;
  }
  private checkUrl(url: string) {
    try { return assertWebhookUrl(url, { allowHttp: this.config.alerts.webhookAllowHttp, allowPrivateHosts: this.config.ingestion.allowPrivateHosts }); }
    catch (e) { throw badRequest('validation_failed', `Invalid webhook URL: ${(e as Error).message}`, [{ field: 'url', problems: [(e as Error).message] }]); }
  }

  /** Names only, for choosing notification targets in a rule; URLs, secrets and delivery logs need integrations:manage. */
  webhookOptions(auth: AuthContext, t: TenantContext) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => (await c.query(
      `SELECT id, name, min_severity, is_active, verified_at FROM webhook_endpoints ORDER BY name`)).rows);
  }

  webhooks(auth: AuthContext, t: TenantContext) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => (await c.query(
      `SELECT e.id, e.name, e.url, e.is_active, e.verified_at, e.min_severity, e.consecutive_failures, e.previous_secret_expires_at, e.created_at, e.updated_at,
         (SELECT count(*)::int FROM webhook_deliveries d WHERE d.endpoint_id = e.id AND d.status = 'delivered') AS delivered,
         (SELECT count(*)::int FROM webhook_deliveries d WHERE d.endpoint_id = e.id AND d.status IN ('failed','dead')) AS failed
       FROM webhook_endpoints e ORDER BY e.created_at DESC`)).rows);
  }

  createWebhook(auth: AuthContext, t: TenantContext, dto: WebhookDto, meta: RequestMeta) {
    const cipher = this.cipher(); const u = this.checkUrl(dto.url);
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const id = (await c.query<{ id: string }>('SELECT gen_random_uuid() AS id')).rows[0]!.id;
      const secret = newWebhookSecret();
      await c.query(`INSERT INTO webhook_endpoints (id, tenant_id, name, url, secret_ciphertext, key_id, min_severity, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, t.orgId, dto.name, u.toString(), cipher.encrypt(secret, `webhook:${id}`), cipher.keyId, dto.minSeverity ?? 'medium', auth.userId]);
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'webhook.created', targetType: 'webhook', targetId: id, metadata: { name: dto.name, host: u.host }, meta });
      return { id, secret, note: 'Store this signing secret now; it is not shown again. The endpoint receives alerts only after verification.' };
    });
  }

  updateWebhook(auth: AuthContext, t: TenantContext, id: string, dto: WebhookUpdateDto, meta: RequestMeta) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const r = await c.query(`UPDATE webhook_endpoints SET name = coalesce($2, name), min_severity = coalesce($3, min_severity), is_active = coalesce($4, is_active),
        consecutive_failures = CASE WHEN $4 THEN 0 ELSE consecutive_failures END, updated_at = now() WHERE id = $1 RETURNING id`, [id, dto.name ?? null, dto.minSeverity ?? null, dto.isActive ?? null]);
      if (!r.rowCount) throw notFound('Webhook');
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'webhook.updated', targetType: 'webhook', targetId: id, metadata: { ...dto }, meta });
      return { id };
    });
  }

  deleteWebhook(auth: AuthContext, t: TenantContext, id: string, meta: RequestMeta) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const r = await c.query('DELETE FROM webhook_endpoints WHERE id = $1 RETURNING name', [id]);
      if (!r.rowCount) throw notFound('Webhook');
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'webhook.deleted', targetType: 'webhook', targetId: id, metadata: { name: r.rows[0].name }, meta });
    });
  }

  /** Signed challenge; the receiver must answer 2xx with {"challenge": "<same value>"}. Proves control of the URL. */
  async verifyWebhook(auth: AuthContext, t: TenantContext, id: string, meta: RequestMeta) {
    const cipher = this.cipher();
    await this.rateLimit(`verify:${t.orgId}`, 5);
    const ep = await this.db.withTenant(t.orgId, auth.userId, async (c) => (await c.query<{ id: string; url: string; secret_ciphertext: string }>(
      'SELECT id, url, secret_ciphertext FROM webhook_endpoints WHERE id = $1', [id])).rows[0]);
    if (!ep) throw notFound('Webhook');
    this.checkUrl(ep.url);
    const challenge = (await import('node:crypto')).randomBytes(16).toString('hex');
    const body = JSON.stringify({ id: `verify_${challenge}`, type: 'webhook.verification', challenge, createdAt: this.clock.now().toISOString() });
    let ok = false; let detail = '';
    try {
      const res = await this.http.post(ep.url, body, { 'x-civicsignal-event': 'webhook.verification',
        'x-civicsignal-signature': signWebhook(body, [cipher.decrypt(ep.secret_ciphertext, `webhook:${id}`)], Math.floor(this.clock.now().getTime() / 1000)) });
      const echoed = (() => { try { return JSON.parse(res.body.toString('utf8')).challenge; } catch { return null; } })();
      ok = res.status >= 200 && res.status < 300 && echoed === challenge;
      detail = ok ? 'verified' : res.status >= 300 && res.status < 400 ? `HTTP ${res.status} (redirects are not followed)` : `HTTP ${res.status}${echoed === challenge ? '' : ', challenge not echoed'}`;
    } catch (e) { detail = (e as Error).message.slice(0, 200); }
    await this.db.withTenant(t.orgId, auth.userId, async (c) => {
      if (ok) await c.query('UPDATE webhook_endpoints SET verified_at = $2, is_active = true, consecutive_failures = 0, updated_at = now() WHERE id = $1', [id, this.clock.now()]);
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: ok ? 'webhook.verified' : 'webhook.verification_failed', targetType: 'webhook', targetId: id, metadata: { detail }, meta });
    });
    if (!ok) throw badRequest('webhook_verification_failed', `Verification failed: ${detail}`);
    return { verified: true };
  }

  rotateSecret(auth: AuthContext, t: TenantContext, id: string, dto: RotateDto, meta: RequestMeta) {
    const cipher = this.cipher();
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const ep = (await c.query<{ secret_ciphertext: string }>('SELECT secret_ciphertext FROM webhook_endpoints WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!ep) throw notFound('Webhook');
      const secret = newWebhookSecret(); const grace = dto.graceHours ?? 24;
      await c.query(`UPDATE webhook_endpoints SET previous_secret_ciphertext = CASE WHEN $3 > 0 THEN secret_ciphertext END,
        previous_secret_expires_at = CASE WHEN $3 > 0 THEN $4::timestamptz + make_interval(hours => $3) END, secret_ciphertext = $2, key_id = $5, updated_at = now() WHERE id = $1`,
        [id, cipher.encrypt(secret, `webhook:${id}`), grace, this.clock.now(), cipher.keyId]);
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'webhook.secret_rotated', targetType: 'webhook', targetId: id, metadata: { graceHours: grace }, meta });
      return { secret, graceHours: grace, note: `Deliveries are signed with both secrets for ${grace} h.` };
    });
  }

  webhookDeliveries(auth: AuthContext, t: TenantContext, id: string) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => (await c.query(
      `SELECT id, issue_id, event, status, attempts, response_status, duration_ms, error, created_at, delivered_at FROM webhook_deliveries WHERE endpoint_id = $1 ORDER BY created_at DESC LIMIT 100`, [id])).rows);
  }

  // ── Notifications ─────────────────────────────────────────────────────────────────────────────────
  inbox(auth: AuthContext, t: TenantContext, q: InboxQuery) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const items = (await c.query(`SELECT id, issue_id, kind, payload, read_at, created_at FROM notification_deliveries
        WHERE user_id = $1 AND channel = 'in_app' AND ($2 = false OR read_at IS NULL) ORDER BY created_at DESC LIMIT $3`, [auth.userId, q.unread === 'true', q.limit ?? 30])).rows;
      const unread = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM notification_deliveries WHERE user_id = $1 AND channel = 'in_app' AND read_at IS NULL`, [auth.userId])).rows[0]!.n;
      return { unread, items };
    });
  }

  markRead(auth: AuthContext, t: TenantContext, id: string, dto: ReadDto) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const r = await c.query(`UPDATE notification_deliveries SET read_at = CASE WHEN $3 THEN coalesce(read_at, now()) END WHERE id = $1 AND user_id = $2 AND channel = 'in_app' RETURNING id, read_at`,
        [id, auth.userId, dto.read]);
      if (!r.rowCount) throw notFound('Notification');
      return r.rows[0];
    });
  }

  readAll(auth: AuthContext, t: TenantContext) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => ({ updated: (await c.query(
      `UPDATE notification_deliveries SET read_at = now() WHERE user_id = $1 AND channel = 'in_app' AND read_at IS NULL`, [auth.userId])).rowCount }));
  }

  preferences(auth: AuthContext, t: TenantContext) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => ({
      items: (await c.query('SELECT channel, enabled, min_severity, destination, updated_at FROM notification_preferences WHERE user_id = $1', [auth.userId])).rows,
      defaults: { in_app: { enabled: true, minSeverity: 'informational' }, email: { enabled: true, minSeverity: 'medium' }, whatsapp: { enabled: false, minSeverity: 'high' } },
      channels: this.notifications.channelStatus(),
    }));
  }

  setPreferences(auth: AuthContext, t: TenantContext, dto: PreferencesDto, meta: RequestMeta) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      for (const p of dto.items) {
        if (p.channel === 'whatsapp' && p.enabled && !p.destination) throw badRequest('validation_failed', 'WhatsApp needs an opted-in phone number', [{ field: 'destination', problems: ['required'] }]);
        await c.query(`INSERT INTO notification_preferences (tenant_id, user_id, channel, enabled, min_severity, destination, updated_at) VALUES ($1,$2,$3,$4,$5,$6, now())
          ON CONFLICT (tenant_id, user_id, channel) DO UPDATE SET enabled = $4, min_severity = $5, destination = $6, updated_at = now()`,
          [t.orgId, auth.userId, p.channel, p.enabled, p.minSeverity, p.channel === 'whatsapp' ? p.destination ?? null : null]);
      }
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'notification_preferences.updated', metadata: { channels: dto.items.map((x) => `${x.channel}:${x.enabled}:${x.minSeverity}`) }, meta });
      return { updated: dto.items.length };
    });
  }

  /** Delivery log for administrators: status per channel, failures with reasons. */
  deliveries(auth: AuthContext, t: TenantContext) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => ({
      channels: this.notifications.channelStatus(),
      recent: (await c.query(`SELECT d.id, d.issue_id, d.channel, d.kind, d.status, d.attempts, d.last_error, d.created_at, d.sent_at, d.not_before, u.display_name AS recipient
        FROM notification_deliveries d LEFT JOIN users u ON u.id = d.user_id WHERE d.channel <> 'in_app' ORDER BY d.created_at DESC LIMIT 100`)).rows,
      summary: (await c.query(`SELECT channel, status, count(*)::int AS n FROM notification_deliveries WHERE created_at > now() - interval '7 days' GROUP BY 1, 2`)).rows,
    }));
  }

  /** Manual recovery for failed or dead deliveries (email/WhatsApp or webhook). */
  async retryDelivery(auth: AuthContext, t: TenantContext, id: string, kind: 'notification' | 'webhook', meta: RequestMeta) {
    if (!this.enqueuer.available) throw new AppError(503, 'queue_unavailable', 'The alert queue (Redis) is not configured on this server');
    const attempts = await this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const table = kind === 'webhook' ? 'webhook_deliveries' : 'notification_deliveries';
      const r = await c.query<{ attempts: number }>(`UPDATE ${table} SET status = 'pending' WHERE id = $1 AND status IN ('failed','dead') RETURNING attempts`, [id]);
      if (!r.rowCount) throw conflict('not_retryable', 'Only failed or dead deliveries can be retried');
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'notification.retry_requested', targetType: table, targetId: id, meta });
      return r.rows[0]!.attempts;
    });
    await this.enqueuer.deliveries(t.orgId, kind === 'notification' ? [id] : [], kind === 'webhook' ? [id] : [], attempts + 100);
    return { status: 'queued' };
  }
}

@ApiTags('alerts')
@Controller('organizations/:orgId')
@UseGuards(SessionGuard, TenantGuard)
export class AlertRulesController {
  constructor(private readonly svc: RulesService) {}

  @Get('alert-rules') @RequirePermission('alerts:read')
  list(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Query() q: RuleListQuery) { return this.svc.list(a, t, q); }
  @Post('alert-rules/preview') @HttpCode(200) @RequirePermission('alerts:manage')
  preview(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Body() dto: PreviewDto) { return this.svc.preview(a, t, dto); }
  @Post('alert-rules/evaluate') @HttpCode(202) @RequirePermission('alerts:manage')
  evaluate(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Meta() m: RequestMeta) { return this.svc.evaluateNow(a, t, m); }
  @Get('alert-rules/:id') @RequirePermission('alerts:read')
  get(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.get(a, t, id); }
  @Post('alert-rules') @RequirePermission('alerts:manage')
  create(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Body() dto: CreateRuleDto, @Meta() m: RequestMeta) { return this.svc.create(a, t, dto, m); }
  @Patch('alert-rules/:id') @RequirePermission('alerts:manage')
  update(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateRuleDto, @Meta() m: RequestMeta) { return this.svc.update(a, t, id, dto, m); }
  @Delete('alert-rules/:id') @HttpCode(204) @RequirePermission('alerts:manage')
  remove(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Meta() m: RequestMeta) { return this.svc.remove(a, t, id, m); }
  @Post('alert-rules/:id/test') @HttpCode(200) @RequirePermission('alerts:manage')
  test(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Meta() m: RequestMeta) { return this.svc.test(a, t, id, m); }

  @Get('webhooks/options') @RequirePermission('alerts:manage')
  webhookOptions(@Auth() a: AuthContext, @Tenant() t: TenantContext) { return this.svc.webhookOptions(a, t); }
  @Get('webhooks') @RequirePermission('integrations:manage')
  webhooks(@Auth() a: AuthContext, @Tenant() t: TenantContext) { return this.svc.webhooks(a, t); }
  @Post('webhooks') @RequirePermission('integrations:manage')
  createWebhook(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Body() dto: WebhookDto, @Meta() m: RequestMeta) { return this.svc.createWebhook(a, t, dto, m); }
  @Patch('webhooks/:id') @RequirePermission('integrations:manage')
  updateWebhook(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: WebhookUpdateDto, @Meta() m: RequestMeta) { return this.svc.updateWebhook(a, t, id, dto, m); }
  @Delete('webhooks/:id') @HttpCode(204) @RequirePermission('integrations:manage')
  deleteWebhook(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Meta() m: RequestMeta) { return this.svc.deleteWebhook(a, t, id, m); }
  @Post('webhooks/:id/verify') @HttpCode(200) @RequirePermission('integrations:manage')
  verify(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Meta() m: RequestMeta) { return this.svc.verifyWebhook(a, t, id, m); }
  @Post('webhooks/:id/rotate-secret') @HttpCode(200) @RequirePermission('integrations:manage')
  rotate(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RotateDto, @Meta() m: RequestMeta) { return this.svc.rotateSecret(a, t, id, dto, m); }
  @Get('webhooks/:id/deliveries') @RequirePermission('integrations:manage')
  webhookDeliveries(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.webhookDeliveries(a, t, id); }
  @Post('webhook-deliveries/:id/retry') @HttpCode(202) @RequirePermission('integrations:manage')
  retryWebhook(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Meta() m: RequestMeta) { return this.svc.retryDelivery(a, t, id, 'webhook', m); }

  @Get('notifications') @RequirePermission('org:read')
  inbox(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Query() q: InboxQuery) { return this.svc.inbox(a, t, q); }
  @Post('notifications/read-all') @HttpCode(200) @RequirePermission('org:read')
  readAll(@Auth() a: AuthContext, @Tenant() t: TenantContext) { return this.svc.readAll(a, t); }
  @Get('notifications/preferences') @RequirePermission('org:read')
  prefs(@Auth() a: AuthContext, @Tenant() t: TenantContext) { return this.svc.preferences(a, t); }
  @Put('notifications/preferences') @RequirePermission('org:read')
  setPrefs(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Body() dto: PreferencesDto, @Meta() m: RequestMeta) { return this.svc.setPreferences(a, t, dto, m); }
  @Get('notifications/deliveries') @RequirePermission('integrations:manage')
  deliveries(@Auth() a: AuthContext, @Tenant() t: TenantContext) { return this.svc.deliveries(a, t); }
  @Post('notifications/deliveries/:id/retry') @HttpCode(202) @RequirePermission('integrations:manage')
  retry(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Meta() m: RequestMeta) { return this.svc.retryDelivery(a, t, id, 'notification', m); }
  @Patch('notifications/:id') @RequirePermission('org:read')
  read(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReadDto) { return this.svc.markRead(a, t, id, dto); }
}
