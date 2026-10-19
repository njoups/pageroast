import { Body, Controller, Get, HttpCode, Inject, Injectable, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import type { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import { SessionGuard } from '../auth/session.guard';
import { RequirePermission, TenantGuard } from '../authz/guards';
import { hasPermission, seesAllProjects, type Role } from '../authz/permissions';
import { badRequest, conflict, notFound } from '../common/errors';
import { Auth, AuthContext, Meta, RequestMeta, Tenant, TenantContext } from '../common/request';
import { Database } from '../database/database.service';
import { AlertsEnqueuer } from './alerts-queue';
import { CLOCK, type Clock } from './clock';
import { EvaluatorService } from './evaluator.service';
import { canTransition, OPEN_STATUSES, SEVERITIES, STATUSES, type IssueStatus } from './levels';
import { NotificationService, type IssueForNotification } from './notifications.service';
import { RuleConfigSchema } from './rule-config';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class IssueFilter {
  @IsOptional() @IsUUID() projectId?: string;
  @IsOptional() @IsUUID() entityId?: string;
  @IsOptional() @Matches(/^(custom:)?[a-z_0-9]{2,40}$/) topic?: string;
  @IsOptional() @IsIn(SEVERITIES) severity?: string;
  @IsOptional() @IsIn([...SEVERITIES]) minSeverity?: string;
  @IsOptional() @IsUUID() sourceId?: string;
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
  @IsOptional() @IsIn([...STATUSES, 'open']) status?: string;
  @IsOptional() @Matches(/^([0-9a-f-]{36}|none|me)$/) assignedTo?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100_000) offset?: number;
}
class ReasonDto { @Transform(trim) @IsString() @MinLength(3) @MaxLength(2000) reason: string }
class OptionalReasonDto { @IsOptional() @Transform(trim) @IsString() @MaxLength(2000) reason?: string }
class AssignDto { @ValidateIf((_o, v) => v !== null) @IsUUID() userId: string | null }
class NoteDto { @Transform(trim) @IsString() @MinLength(1) @MaxLength(5000) body: string }

const SYS_SEVERITY_ORDER = `array_position(ARRAY['informational','low','medium','high','critical'], i.severity)`;

@Injectable()
export class IssuesService {
  constructor(private readonly db: Database, private readonly audit: AuditService, private readonly evaluator: EvaluatorService,
    private readonly notifications: NotificationService, private readonly enqueuer: AlertsEnqueuer, @Inject(CLOCK) private readonly clock: Clock) {}

  /** Issue visibility follows project visibility (owners/admins: all projects). */
  private visibility(auth: AuthContext, t: TenantContext, params: unknown[]) {
    if (seesAllProjects(t.role)) return 'true';
    params.push(auth.userId);
    return `EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = i.project_id AND pm.user_id = $${params.length})`;
  }

  private where(auth: AuthContext, t: TenantContext, f: IssueFilter) {
    const p: unknown[] = []; const add = (v: unknown) => { p.push(v); return `$${p.length}`; };
    const w = [this.visibility(auth, t, p)];
    if (f.projectId) w.push(`i.project_id = ${add(f.projectId)}`);
    if (f.severity) w.push(`i.severity = ${add(f.severity)}`);
    if (f.minSeverity) w.push(`${SYS_SEVERITY_ORDER} >= array_position(ARRAY['informational','low','medium','high','critical'], ${add(f.minSeverity)}::text)`);
    if (f.status === 'open') w.push(`i.status = ANY(${add(OPEN_STATUSES)}::text[])`); else if (f.status) w.push(`i.status = ${add(f.status)}`);
    if (f.from) w.push(`i.last_detected_at >= ${add(f.from)}::timestamptz`);
    if (f.to) w.push(`i.first_detected_at <= ${add(f.to)}::timestamptz`);
    if (f.assignedTo === 'none') w.push('i.assigned_to IS NULL');
    else if (f.assignedTo === 'me') w.push(`i.assigned_to = ${add(auth.userId)}`);
    else if (f.assignedTo) w.push(`i.assigned_to = ${add(f.assignedTo)}`);
    if (f.topic) w.push(`(i.subject_type = 'topic' AND i.subject_key = ${add(f.topic)} OR EXISTS (SELECT 1 FROM alert_evidence e JOIN mentions m ON m.id = e.mention_id
      JOIN mention_topics mt ON mt.mention_id = m.id AND mt.analysis_id = m.analysis_id WHERE e.issue_id = i.id AND mt.topic_key = ${add(f.topic)}))`);
    if (f.entityId) w.push(`(i.subject_type = 'entity' AND i.subject_key = ${add(f.entityId)} OR EXISTS (SELECT 1 FROM alert_evidence e JOIN mentions m ON m.id = e.mention_id
      JOIN mention_entities me ON me.mention_id = m.id AND me.analysis_id = m.analysis_id WHERE e.issue_id = i.id AND me.entity_id = ${add(f.entityId)}))`);
    if (f.sourceId) w.push(`EXISTS (SELECT 1 FROM alert_evidence e JOIN mentions m ON m.id = e.mention_id WHERE e.issue_id = i.id AND m.source_id = ${add(f.sourceId)})`);
    return { sql: w.join(' AND '), params: p, add };
  }

  list(auth: AuthContext, t: TenantContext, f: IssueFilter) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const { sql, params, add } = this.where(auth, t, f);
      const total = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM detected_issues i WHERE ${sql}`, params)).rows[0]!.n;
      const items = (await c.query(
        `SELECT i.id, i.project_id, p.name AS project_name, i.rule_id, r.name AS rule_name, i.rule_version, i.scope, i.signal, i.subject_type, i.subject_key, i.title,
           i.status, i.severity, i.severity_points, i.first_detected_at, i.last_detected_at, i.occurrence_count, i.acknowledged_at, i.assigned_to,
           u.display_name AS assigned_to_name, i.escalation_level, i.group_key,
           (SELECT count(*)::int FROM alert_evidence e WHERE e.issue_id = i.id) AS evidence_count,
           (SELECT count(DISTINCT m.publisher_domain)::int FROM alert_evidence e JOIN mentions m ON m.id = e.mention_id WHERE e.issue_id = i.id) AS publisher_count,
           (SELECT count(DISTINCT m.publisher_domain)::int FROM alert_evidence e JOIN mentions m ON m.id = e.mention_id WHERE e.issue_id = i.id AND NOT e.is_syndicated) AS independent_publishers,
           (SELECT count(*)::int FROM detected_issues g WHERE g.group_key = i.group_key AND g.id <> i.id) AS related_count
         FROM detected_issues i JOIN projects p ON p.id = i.project_id JOIN alert_rules r ON r.id = i.rule_id LEFT JOIN users u ON u.id = i.assigned_to
         WHERE ${sql} ORDER BY (i.status IN ('resolved','closed')), ${SYS_SEVERITY_ORDER} DESC, i.last_detected_at DESC
         LIMIT ${add(f.limit ?? 50)} OFFSET ${add(f.offset ?? 0)}`, params)).rows;
      return { total, items };
    });
  }

  private async load(c: PoolClient, auth: AuthContext, t: TenantContext, id: string, lock = false) {
    const p: unknown[] = [id];
    const vis = this.visibility(auth, t, p);
    const i = (await c.query<IssueForNotification & { status: IssueStatus; rule_version: number; rule_id: string; assigned_to: string | null; resolved_at: Date | null }>(
      `SELECT i.* FROM detected_issues i WHERE i.id = $1 AND ${vis} ${lock ? 'FOR UPDATE' : ''}`, p)).rows[0];
    if (!i) throw notFound('Issue');
    return i;
  }

  detail(auth: AuthContext, t: TenantContext, id: string) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const i = await this.load(c, auth, t, id);
      const rule = (await c.query(`SELECT r.id, r.name, r.rule_type, r.is_active, r.deleted_at, r.current_version, v.version, v.config, v.created_at AS version_created_at
        FROM alert_rules r JOIN alert_rule_versions v ON v.rule_id = r.id AND v.version = $2 WHERE r.id = $1`, [i.rule_id, i.rule_version])).rows[0];
      const evidence = (await c.query(
        `SELECT m.id, m.title, m.url, coalesce(m.publisher, m.publisher_domain) AS publisher, m.publisher_domain, m.published_at, m.discovered_at, m.source_id, s.name AS source_name,
           e.cluster_id, e.is_syndicated, e.role, e.added_at, sr.label AS sentiment, sr.uncertain AS sentiment_uncertain, m.detected_language,
           (SELECT coalesce(jsonb_agg(mt.topic_key), '[]'::jsonb) FROM mention_topics mt WHERE mt.analysis_id = m.analysis_id AND mt.topic_key <> 'unknown') AS topics
         FROM alert_evidence e JOIN mentions m ON m.id = e.mention_id JOIN sources s ON s.id = m.source_id
         LEFT JOIN sentiment_results sr ON sr.analysis_id = m.analysis_id AND sr.target_type = 'article'
         WHERE e.issue_id = $1 ORDER BY coalesce(m.published_at, m.discovered_at) DESC LIMIT 200`, [id])).rows;
      const totals = (await c.query(`SELECT count(*)::int AS records, count(DISTINCT m.publisher_domain)::int AS publishers,
          count(DISTINCT m.publisher_domain) FILTER (WHERE NOT e.is_syndicated)::int AS independent_publishers, count(*) FILTER (WHERE e.is_syndicated)::int AS syndicated
        FROM alert_evidence e JOIN mentions m ON m.id = e.mention_id WHERE e.issue_id = $1`, [id])).rows[0];
      const sentiment = (await c.query(`SELECT coalesce(sr.label, 'not analysed') AS label, count(*)::int AS n, count(*) FILTER (WHERE sr.uncertain)::int AS uncertain
        FROM alert_evidence e JOIN mentions m ON m.id = e.mention_id LEFT JOIN sentiment_results sr ON sr.analysis_id = m.analysis_id AND sr.target_type = 'article'
        WHERE e.issue_id = $1 GROUP BY 1`, [id])).rows;
      const topics = (await c.query(`SELECT mt.topic_key, max(pt.label) AS custom_label, count(DISTINCT m.id)::int AS n FROM alert_evidence e JOIN mentions m ON m.id = e.mention_id
        JOIN mention_topics mt ON mt.mention_id = m.id AND mt.analysis_id = m.analysis_id LEFT JOIN project_topics pt ON pt.id = mt.project_topic_id
        WHERE e.issue_id = $1 AND mt.topic_key <> 'unknown' GROUP BY 1 ORDER BY 3 DESC LIMIT 10`, [id])).rows;
      const entities = (await c.query(`SELECT en.id, en.display_name, en.entity_type, count(DISTINCT m.id)::int AS n FROM alert_evidence e JOIN mentions m ON m.id = e.mention_id
        JOIN mention_entities me ON me.mention_id = m.id AND me.analysis_id = m.analysis_id JOIN entities en ON en.id = me.entity_id
        WHERE e.issue_id = $1 GROUP BY en.id ORDER BY 4 DESC LIMIT 15`, [id])).rows;
      const clusters = (await c.query(`SELECT sc.id, sc.label, sc.member_count, sc.independent_count, sc.publisher_count, sc.status, count(*)::int AS in_issue
        FROM alert_evidence e JOIN story_clusters sc ON sc.id = e.cluster_id WHERE e.issue_id = $1 GROUP BY sc.id ORDER BY 7 DESC LIMIT 10`, [id])).rows;
      const events = (await c.query(`SELECT ev.id, ev.event, ev.from_status, ev.to_status, ev.details, ev.at, u.display_name AS actor_name
        FROM alert_events ev LEFT JOIN users u ON u.id = ev.actor_user_id WHERE ev.issue_id = $1 ORDER BY ev.at, ev.id`, [id])).rows;
      const notes = (await c.query(`SELECT n.id, n.body, n.created_at, u.display_name AS author_name, n.author_user_id FROM alert_notes n LEFT JOIN users u ON u.id = n.author_user_id
        WHERE n.issue_id = $1 ORDER BY n.created_at`, [id])).rows;
      const assignments = (await c.query(`SELECT a.assigned_to, ua.display_name AS assigned_to_name, a.assigned_by, ub.display_name AS assigned_by_name, a.assigned_at, a.unassigned_at
        FROM alert_assignments a LEFT JOIN users ua ON ua.id = a.assigned_to LEFT JOIN users ub ON ub.id = a.assigned_by WHERE a.issue_id = $1 ORDER BY a.assigned_at`, [id])).rows;
      const p: unknown[] = [i.id, (i as unknown as { group_key: string }).group_key];
      const related = (await c.query(`SELECT i.id, i.title, i.severity, i.status, i.signal, i.last_detected_at FROM detected_issues i
        WHERE i.group_key = $2 AND i.id <> $1 AND ${this.visibility(auth, t, p)} ORDER BY i.last_detected_at DESC LIMIT 10`, p)).rows;
      const deliveries = (await c.query(`SELECT channel, status, count(*)::int AS n FROM notification_deliveries WHERE issue_id = $1 GROUP BY 1, 2`, [id])).rows;
      const assignee = i.assigned_to ? (await c.query('SELECT id, display_name FROM users WHERE id = $1', [i.assigned_to])).rows[0] : null;
      return {
        issue: { ...i, assignee }, rule, evidence, totals, sentiment, topics, entities, clusters, events, notes, assignments, related, deliveries,
        disclaimer: 'Detected automatically from collected coverage. Severity follows documented rules; summaries and classifications are automated estimates, not verified facts.',
      };
    });
  }

  private async transition(auth: AuthContext, t: TenantContext, id: string, to: IssueStatus, meta: RequestMeta, details: Record<string, unknown>,
    apply: (c: PoolClient, issue: Awaited<ReturnType<IssuesService['load']>>) => Promise<void> = async () => undefined) {
    const now = this.clock.now();
    const out = await this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const i = await this.load(c, auth, t, id, true);
      if (!canTransition(i.status, to)) throw conflict('invalid_transition', `An issue cannot move from ${i.status} to ${to}`);
      await apply(c, i);
      await c.query(`UPDATE detected_issues SET status = $2::text, updated_at = $3,
          acknowledged_by = CASE WHEN $2::text = 'acknowledged' THEN coalesce(acknowledged_by, $4::uuid) ELSE acknowledged_by END,
          acknowledged_at = CASE WHEN $2::text = 'acknowledged' THEN coalesce(acknowledged_at, $3) ELSE acknowledged_at END,
          resolved_at = CASE WHEN $2::text = 'resolved' THEN $3 WHEN $2::text = 'pending_review' THEN NULL ELSE resolved_at END,
          resolution_reason = CASE WHEN $2::text = 'resolved' THEN $5::text ELSE resolution_reason END,
          closed_at = CASE WHEN $2::text = 'closed' THEN $3 WHEN $2::text = 'pending_review' THEN NULL ELSE closed_at END
        WHERE id = $1`, [id, to, now, auth.userId, typeof details.reason === 'string' ? details.reason : null]);
      await this.evaluator.event(c, t.orgId, id, to === 'pending_review' ? 'reopened' : 'status_changed', i.status, to, details, auth.userId);
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: `issue.${to === 'pending_review' ? 'reopened' : to}`, targetType: 'issue', targetId: id,
        metadata: { from: i.status, to, ...details }, meta });
      let planned = { deliveryIds: [] as string[], webhookDeliveryIds: [] as string[] };
      if (to === 'resolved') {
        const v = (await c.query<{ config: unknown; owner_user_id: string | null }>(
          `SELECT v.config, r.owner_user_id FROM alert_rule_versions v JOIN alert_rules r ON r.id = v.rule_id WHERE v.rule_id = $1 AND v.version = $2`, [i.rule_id, i.rule_version])).rows[0]!;
        const cfg = RuleConfigSchema.parse(v.config);
        const recipients = cfg.notify.recipientUserIds.length ? cfg.notify.recipientUserIds : v.owner_user_id ? [v.owner_user_id] : [];
        const fresh = (await c.query<IssueForNotification>('SELECT * FROM detected_issues WHERE id = $1', [id])).rows[0]!;
        planned = await this.notifications.plan(c, fresh, 'resolved', String(now.getTime()), cfg, recipients.filter((u) => u !== auth.userId), { resolutionReason: details.reason });
      }
      return { status: to, planned };
    });
    await this.enqueuer.deliveries(t.orgId, out.planned.deliveryIds, out.planned.webhookDeliveryIds);
    return { status: out.status };
  }

  acknowledge(a: AuthContext, t: TenantContext, id: string, m: RequestMeta) { return this.transition(a, t, id, 'acknowledged', m, {}); }
  investigate(a: AuthContext, t: TenantContext, id: string, m: RequestMeta) {
    return this.transition(a, t, id, 'investigating', m, {}, async (c, i) => {
      // Starting an investigation implies acknowledgement.
      if (!i.assigned_to) await this.assignIn(c, t, id, a.userId, a.userId);
      await c.query('UPDATE detected_issues SET acknowledged_by = coalesce(acknowledged_by, $2), acknowledged_at = coalesce(acknowledged_at, $3) WHERE id = $1', [id, a.userId, this.clock.now()]);
    });
  }
  resolve(a: AuthContext, t: TenantContext, id: string, dto: ReasonDto, m: RequestMeta) { return this.transition(a, t, id, 'resolved', m, { reason: dto.reason }); }
  close(a: AuthContext, t: TenantContext, id: string, dto: OptionalReasonDto, m: RequestMeta) { return this.transition(a, t, id, 'closed', m, { reason: dto.reason ?? null }); }
  reopen(a: AuthContext, t: TenantContext, id: string, dto: ReasonDto, m: RequestMeta) {
    return this.transition(a, t, id, 'pending_review', m, { reason: dto.reason, automatic: false }, async (c, i) => {
      // A closed issue may have been succeeded by a newer one for the same rule and subject; reopen that one instead.
      const other = (await c.query(`SELECT id FROM detected_issues WHERE dedup_key = (SELECT dedup_key FROM detected_issues WHERE id = $1) AND id <> $1 AND status <> 'closed'`, [i.id])).rows[0];
      if (other) throw conflict('newer_issue_open', `A newer issue for the same rule and subject is open (${other.id})`);
    });
  }

  private async assignIn(c: PoolClient, t: TenantContext, id: string, userId: string | null, by: string) {
    const now = this.clock.now();
    await c.query('UPDATE alert_assignments SET unassigned_at = $2 WHERE issue_id = $1 AND unassigned_at IS NULL', [id, now]);
    if (userId) await c.query('INSERT INTO alert_assignments (tenant_id, issue_id, assigned_to, assigned_by, assigned_at) VALUES ($1,$2,$3,$4,$5)', [t.orgId, id, userId, by, now]);
    await c.query('UPDATE detected_issues SET assigned_to = $2, updated_at = $3 WHERE id = $1', [id, userId, now]);
    await this.evaluator.event(c, t.orgId, id, userId ? 'assigned' : 'unassigned', null, null, { userId }, by);
  }

  assign(auth: AuthContext, t: TenantContext, id: string, dto: AssignDto, meta: RequestMeta) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const i = await this.load(c, auth, t, id, true);
      if (i.status === 'closed') throw conflict('issue_closed', 'Reopen the issue before assigning it');
      if (dto.userId) {
        // The assignee must be a member who can see this project's issues.
        const m = (await c.query<{ role: Role; assigned: boolean }>(`SELECT m.role, EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = $2 AND pm.user_id = m.user_id) AS assigned
          FROM memberships m WHERE m.user_id = $1`, [dto.userId, i.project_id])).rows[0];
        if (!m || !hasPermission(m.role, 'alerts:read') || (!seesAllProjects(m.role) && !m.assigned)) throw badRequest('invalid_assignee', 'The assignee must be a member with access to this project\'s issues');
      }
      await this.assignIn(c, t, id, dto.userId, auth.userId);
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'issue.assigned', targetType: 'issue', targetId: id, metadata: { assignedTo: dto.userId }, meta });
      return { assignedTo: dto.userId };
    });
  }

  addNote(auth: AuthContext, t: TenantContext, id: string, dto: NoteDto, meta: RequestMeta) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const i = await this.load(c, auth, t, id);
      const n = (await c.query<{ id: string; created_at: Date }>('INSERT INTO alert_notes (tenant_id, issue_id, author_user_id, body, created_at) VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at',
        [t.orgId, i.id, auth.userId, dto.body, this.clock.now()])).rows[0]!;
      await this.evaluator.event(c, t.orgId, id, 'note_added', null, null, { noteId: n.id }, auth.userId);
      // The audit log records that a note was added, not its content.
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'issue.note_added', targetType: 'issue', targetId: id, metadata: { noteId: n.id }, meta });
      return n;
    });
  }

  /** Dashboard data from persisted issues and pre-computed activity tables only. */
  dashboard(auth: AuthContext, t: TenantContext, f: IssueFilter) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const now = this.clock.now();
      const { sql, params } = this.where(auth, t, { ...f, status: undefined });
      const counts = (await c.query(`SELECT i.severity, i.status, count(*)::int AS n FROM detected_issues i WHERE ${sql} GROUP BY 1, 2`, params)).rows;
      const pa: unknown[] = []; const vis = seesAllProjects(t.role) ? 'true' : (pa.push(auth.userId), `EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = a.project_id AND pm.user_id = $${pa.length})`);
      const proj = f.projectId ? (pa.push(f.projectId), `AND a.project_id = $${pa.length}`) : '';
      const from = f.from ? new Date(f.from) : new Date(now.getTime() - 14 * 86_400_000); const to = f.to ? new Date(f.to) : now;
      const fi = pa.length + 1; const ti = pa.length + 2;
      // Several projects can match one record; without a project filter the series counts project-matched records.
      const series = (await c.query(`SELECT to_char(date_trunc('day', a.hour), 'YYYY-MM-DD') AS day, sum(a.mentions)::int AS mentions, max(a.publishers)::int AS publishers_max,
          sum(a.analysed)::int AS analysed, sum(a.positive)::int AS positive, sum(a.negative)::int AS negative, sum(a.neutral)::int AS neutral, sum(a.mixed)::int AS mixed,
          sum(a.uncertain)::int AS uncertain, max(a.refreshed_at) AS refreshed_at
        FROM activity_hourly a WHERE ${vis} ${proj} AND a.hour >= $${fi} AND a.hour <= $${ti} GROUP BY 1 ORDER BY 1`, [...pa, from, to])).rows;
      // Days on which collection actually succeeded: days without runs are gaps, not zero coverage.
      const coverage = (await c.query(`SELECT to_char(date_trunc('day', finished_at), 'YYYY-MM-DD') AS day, count(*)::int AS runs FROM connector_runs
        WHERE status = 'succeeded' AND finished_at >= $1 AND finished_at <= $2 GROUP BY 1 ORDER BY 1`, [from, to])).rows;
      const ei = pa.length + 1;
      const emerging = (await c.query(`WITH recent AS (SELECT a.topic_key, sum(a.mentions)::int AS n, max(a.publishers)::int AS pubs FROM topic_activity_daily a
          WHERE ${vis} ${proj} AND a.day > ($${ei}::timestamptz - interval '3 days')::date GROUP BY 1),
        prior AS (SELECT a.topic_key, sum(a.mentions)::numeric / 11 AS per3 FROM topic_activity_daily a
          WHERE ${vis} ${proj} AND a.day > ($${ei}::timestamptz - interval '14 days')::date AND a.day <= ($${ei}::timestamptz - interval '3 days')::date GROUP BY 1)
        SELECT r.topic_key, r.n, r.pubs, round(coalesce(p.per3, 0) * 3, 1) AS prior_per_3_days, max(pt.label) AS custom_label
        FROM recent r LEFT JOIN prior p ON p.topic_key = r.topic_key LEFT JOIN project_topics pt ON pt.key = r.topic_key
        WHERE r.topic_key NOT IN ('unknown','other') GROUP BY r.topic_key, r.n, r.pubs, p.per3 ORDER BY (r.n - coalesce(p.per3, 0) * 3) DESC LIMIT 8`, [...pa, to])).rows;
      const active = (await c.query(`SELECT i.id, i.title, i.severity, i.status, i.signal, i.scope, i.first_detected_at, i.last_detected_at, i.acknowledged_at, i.assigned_to,
          (SELECT count(DISTINCT m.publisher_domain)::int FROM alert_evidence e JOIN mentions m ON m.id = e.mention_id WHERE e.issue_id = i.id AND NOT e.is_syndicated) AS independent_publishers,
          (SELECT count(*)::int FROM alert_evidence e WHERE e.issue_id = i.id) AS evidence_count
        FROM detected_issues i WHERE ${sql} AND i.status = ANY($${params.length + 1}::text[]) AND i.severity IN ('high','critical')
        ORDER BY ${SYS_SEVERITY_ORDER} DESC, i.first_detected_at LIMIT 10`, [...params, OPEN_STATUSES])).rows;
      const timeline = (await c.query(`SELECT ev.event, ev.at, ev.from_status, ev.to_status, i.id AS issue_id, i.title, i.severity FROM alert_events ev JOIN detected_issues i ON i.id = ev.issue_id
        WHERE ${sql} AND ev.event IN ('detected','severity_changed','status_changed','reopened','escalated') ORDER BY ev.at DESC LIMIT 25`, params)).rows;
      const clusters = (await c.query(`SELECT sc.id, sc.label, sc.member_count, sc.independent_count, sc.publisher_count, count(DISTINCT i.id)::int AS issues
        FROM detected_issues i JOIN alert_evidence e ON e.issue_id = i.id JOIN story_clusters sc ON sc.id = e.cluster_id
        WHERE ${sql} AND i.status = ANY($${params.length + 1}::text[]) GROUP BY sc.id ORDER BY sc.independent_count DESC, sc.member_count DESC LIMIT 8`, [...params, OPEN_STATUSES])).rows;
      const freshness = (await c.query(`SELECT s.id, s.name, s.enabled, s.refresh_interval_seconds, s.last_success_at, s.last_attempt_at, s.consecutive_failures FROM sources s
        ORDER BY s.enabled DESC, s.last_success_at DESC NULLS LAST LIMIT 20`)).rows;
      const lastEvaluation = (await c.query(`SELECT finished_at, status, rules_evaluated, suppressed FROM alert_evaluations ORDER BY started_at DESC LIMIT 1`)).rows[0] ?? null;
      return { generatedAt: now, range: { from, to }, counts, series, coverage, emerging, active, timeline, clusters, freshness, lastEvaluation,
        notes: ['Charts read pre-computed hourly aggregates (refreshed by each evaluation); the last refresh time is shown.',
          'Days without collection appear as gaps, not as zero coverage.', 'Tone counts exclude uncertain classifications, which are shown separately.'] };
    });
  }
}

@ApiTags('issues')
@Controller('organizations/:orgId')
@UseGuards(SessionGuard, TenantGuard)
export class IssuesController {
  constructor(private readonly svc: IssuesService) {}

  @Get('issues') @RequirePermission('alerts:read')
  list(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Query() f: IssueFilter) { return this.svc.list(a, t, f); }
  @Get('issues/dashboard') @RequirePermission('alerts:read')
  dashboard(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Query() f: IssueFilter) { return this.svc.dashboard(a, t, f); }
  @Get('issues/:id') @RequirePermission('alerts:read')
  detail(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.detail(a, t, id); }
  @Post('issues/:id/acknowledge') @HttpCode(200) @RequirePermission('alerts:acknowledge')
  ack(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Meta() m: RequestMeta) { return this.svc.acknowledge(a, t, id, m); }
  @Post('issues/:id/investigate') @HttpCode(200) @RequirePermission('alerts:acknowledge')
  investigate(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Meta() m: RequestMeta) { return this.svc.investigate(a, t, id, m); }
  @Post('issues/:id/assign') @HttpCode(200) @RequirePermission('alerts:acknowledge')
  assign(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignDto, @Meta() m: RequestMeta) { return this.svc.assign(a, t, id, dto, m); }
  @Post('issues/:id/resolve') @HttpCode(200) @RequirePermission('alerts:acknowledge')
  resolve(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto, @Meta() m: RequestMeta) { return this.svc.resolve(a, t, id, dto, m); }
  @Post('issues/:id/close') @HttpCode(200) @RequirePermission('alerts:manage')
  close(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: OptionalReasonDto, @Meta() m: RequestMeta) { return this.svc.close(a, t, id, dto, m); }
  @Post('issues/:id/reopen') @HttpCode(200) @RequirePermission('alerts:acknowledge')
  reopen(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto, @Meta() m: RequestMeta) { return this.svc.reopen(a, t, id, dto, m); }
  @Post('issues/:id/notes') @RequirePermission('alerts:acknowledge')
  note(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: NoteDto, @Meta() m: RequestMeta) { return this.svc.addNote(a, t, id, dto, m); }
}
