import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AppConfig, CONFIG } from '../config';
import { Database } from '../database/database.service';
import { logEvent } from '../ingestion/log';
import { topicLabel as defaultTopicLabel } from '../analysis/taxonomy';
import { CLOCK, type Clock } from './clock';
import { buildWindows, detect, type Candidate } from './detection';
import { atLeast, severityRank, type Severity } from './levels';
import { NotificationService, type IssueForNotification } from './notifications.service';
import { coverageFn, loadCoverage, loadPopulation, refreshActivity } from './population';
import { RuleConfigSchema, type RuleConfig, type RuleType } from './rule-config';
import { computeSeverity } from './severity';

const SYS = '00000000-0000-0000-0000-000000000000';
const COVERAGE_GRACE_MS = 2 * 3_600_000;

export interface RuleRow { id: string; project_id: string; name: string; rule_type: RuleType; current_version: number; owner_user_id: string | null; config: RuleConfig }
export interface RuleOutcome {
  ruleId: string; ruleVersion: number; signal: RuleType; subject: string; title: string; triggered: boolean;
  suppressed: string | null; severity: Severity | null; result: Candidate['result']; evidenceCount: number;
  action?: 'created' | 'updated' | 'unchanged' | 'reopened' | 'below_severity_minimum';
  issueId?: string;
}
export interface EvaluationResult { evaluationId: string | null; rules: number; created: number; updated: number; outcomes: RuleOutcome[]; deliveries: string[]; webhookDeliveries: string[]; issuesTouched: string[] }

/**
 * Evaluates a tenant's active rules against persisted mentions and creates/updates issues. Idempotent per
 * (tenant, bucket): the evaluation ledger row is claimed first, issues are unique per open dedup key, evidence is
 * unique per (issue, mention), and notifications are unique per (issue, event marker, recipient, channel).
 */
@Injectable()
export class EvaluatorService {
  constructor(private readonly db: Database, @Inject(CONFIG) private readonly config: AppConfig, @Inject(CLOCK) private readonly clock: Clock,
    private readonly notifications: NotificationService) {}

  async activeRules(c: PoolClient, ruleId?: string): Promise<RuleRow[]> {
    const r = await c.query<RuleRow & { config: unknown }>(
      `SELECT r.id, r.project_id, r.name, r.rule_type, r.current_version, r.owner_user_id, v.config FROM alert_rules r
       JOIN alert_rule_versions v ON v.rule_id = r.id AND v.version = r.current_version
       JOIN projects p ON p.id = r.project_id AND p.status = 'active'
       WHERE r.deleted_at IS NULL ${ruleId ? 'AND r.id = $1' : 'AND r.is_active'}`, ruleId ? [ruleId] : []);
    // Stored configs were validated on write; re-parsing applies defaults added since, and rejects tampered rows.
    return r.rows.map((x) => ({ ...x, config: RuleConfigSchema.parse(x.config) }));
  }

  /** Runs one rule's detection and returns candidates with severity; no writes. Used by evaluation and by dry runs. */
  async assess(c: PoolClient, rule: RuleRow, now: Date): Promise<Array<{ candidate: Candidate; severity: ReturnType<typeof computeSeverity>; topicRelevant: boolean }>> {
    const cfg = rule.config;
    const len = cfg.window.minutes * 60_000;
    const lookbackEnd = now.getTime();
    const lookbackStart = cfg.window.comparison === 'same_time_previous_days'
      ? lookbackEnd - cfg.window.baselineWindows * 86_400_000 - len : lookbackEnd - (cfg.window.baselineWindows + 1) * len;
    const { rows, capped } = await loadPopulation(c, rule.project_id, cfg.filters, lookbackStart, lookbackEnd);
    const cov = await loadCoverage(c, cfg.filters.sourceIds, lookbackStart, lookbackEnd + 1);
    const windows = buildWindows(lookbackEnd, cfg.window, coverageFn(cov.times, COVERAGE_GRACE_MS));
    // The current window is "covered" if any collection succeeded since it began (records keep arriving afterwards).
    windows.current.covered = cov.times.some((t) => t > windows.current.from) || (cov.latestSuccess !== null && cov.latestSuccess > windows.current.from);
    const custom = (await c.query<{ key: string; label: string }>('SELECT key, label FROM project_topics WHERE project_id = $1', [rule.project_id])).rows;
    const label = (k: string) => custom.find((t) => t.key === k)?.label ?? defaultTopicLabel(k);
    let subject: { type: Candidate['subjectType']; key: string; label: string };
    if (cfg.filters.entityIds.length === 1) {
      const e = (await c.query<{ display_name: string }>('SELECT display_name FROM entities WHERE id = $1', [cfg.filters.entityIds[0]])).rows[0];
      subject = { type: 'entity', key: cfg.filters.entityIds[0]!, label: e?.display_name ?? 'entity' };
    } else if (cfg.filters.topics.length === 1) subject = { type: 'topic', key: cfg.filters.topics[0]!, label: label(cfg.filters.topics[0]!) };
    else {
      const p = (await c.query<{ name: string }>('SELECT name FROM projects WHERE id = $1', [rule.project_id])).rows[0];
      subject = { type: 'project', key: rule.project_id, label: p?.name ?? 'project' };
    }
    const candidates = detect({ type: rule.rule_type, config: cfg, rows, windows, projectId: rule.project_id, subject, topicLabel: label });
    const stale = cov.latestSuccess === null || now.getTime() - cov.latestSuccess > this.config.alerts.collectionStaleHours * 3_600_000;
    const coveredBaseline = windows.baseline.filter((w) => w.covered).length;
    return candidates.map((candidate) => {
      if (capped) candidate.result.limitations.push(`Population capped at 50,000 records; counts are lower bounds.`);
      if (coveredBaseline < windows.baseline.length) {
        candidate.result.limitations.push(`${windows.baseline.length - coveredBaseline} of ${windows.baseline.length} comparison windows had no successful collection and were excluded (historical gaps).`);
      }
      if (stale) candidate.result.limitations.push('Collection is stale: no successful run recently; current counts may be incomplete.');
      const topicRelevant = cfg.filters.entityIds.length > 0 || (candidate.subjectType === 'topic' && candidate.subjectKey.startsWith('custom:'))
        || cfg.filters.topics.some((t) => t.startsWith('custom:'));
      const severity = computeSeverity(candidate, { topicRelevant, collectionStale: stale, now: now.getTime(), floor: cfg.severity.floor });
      return { candidate, severity, topicRelevant };
    });
  }

  async evaluateTenant(tenantId: string, trigger: string, opts: { bucketKey?: string } = {}): Promise<EvaluationResult> {
    const now = this.clock.now();
    const bucket = opts.bucketKey ?? String(Math.floor(now.getTime() / (this.config.alerts.bucketMinutes * 60_000)));
    return this.db.withTenant(tenantId, SYS, async (c) => {
      // Serialises evaluation per tenant (concurrent workers, overlapping triggers).
      await c.query(`SELECT pg_advisory_xact_lock(hashtextextended('civicsignal:alerts:' || $1::text, 0))`, [tenantId]);
      const ev = (await c.query<{ id: string }>(
        `INSERT INTO alert_evaluations (tenant_id, idempotency_key, trigger, started_at) VALUES ($1,$2,$3,$4)
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING id`, [tenantId, bucket, trigger, now])).rows[0];
      if (!ev) return { evaluationId: null, rules: 0, created: 0, updated: 0, outcomes: [], deliveries: [], webhookDeliveries: [], issuesTouched: [] };
      await refreshActivity(c, tenantId, new Date(now.getTime() - this.config.alerts.refreshHours * 3_600_000), now);
      const rules = await this.activeRules(c);
      const out: EvaluationResult = { evaluationId: ev.id, rules: rules.length, created: 0, updated: 0, outcomes: [], deliveries: [], webhookDeliveries: [], issuesTouched: [] };
      for (const rule of rules) {
        for (const { candidate, severity } of await this.assess(c, rule, now)) {
          const o: RuleOutcome = { ruleId: rule.id, ruleVersion: rule.current_version, signal: candidate.signal, subject: `${candidate.subjectType}:${candidate.subjectKey}`,
            title: candidate.title, triggered: candidate.result.triggered, suppressed: candidate.result.suppressed ? `${candidate.result.suppressed.reason}: ${candidate.result.suppressed.detail}` : null,
            severity: candidate.result.triggered ? severity.severity : null, result: candidate.result, evidenceCount: candidate.evidence.length };
          if (candidate.result.triggered) {
            if (!atLeast(severity.severity, rule.config.severity.minimum)) o.action = 'below_severity_minimum';
            else {
              const r = await this.applyCandidate(c, tenantId, rule, candidate, severity, now);
              o.action = r.action; o.issueId = r.issueId;
              if (r.action === 'created') out.created++; else if (r.action !== 'unchanged') out.updated++;
              out.deliveries.push(...r.deliveries); out.webhookDeliveries.push(...r.webhooks);
              if (r.action !== 'unchanged') out.issuesTouched.push(r.issueId);
            }
          }
          out.outcomes.push(o);
        }
      }
      const esc = await this.escalate(c, tenantId, now);
      out.deliveries.push(...esc.deliveries); out.webhookDeliveries.push(...esc.webhooks);
      await c.query(`UPDATE alert_evaluations SET status = 'succeeded', finished_at = $2, rules_evaluated = $3, issues_created = $4, issues_updated = $5, suppressed = $6 WHERE id = $1`,
        [ev.id, this.clock.now(), rules.length, out.created, out.updated,
          JSON.stringify(out.outcomes.filter((x) => x.suppressed || x.action === 'below_severity_minimum').slice(0, 100).map((x) => ({ ruleId: x.ruleId, subject: x.subject, reason: x.suppressed ?? x.action })))]);
      logEvent('info', 'alerts.evaluated', { tenantId, trigger, rules: rules.length, created: out.created, updated: out.updated });
      return out;
    });
  }

  /** Creates, updates, re-detects or reopens the issue for a triggered candidate. */
  private async applyCandidate(c: PoolClient, tenantId: string, rule: RuleRow, cand: Candidate, sev: ReturnType<typeof computeSeverity>, now: Date) {
    const dedup = `${rule.id}:${cand.subjectType}:${cand.subjectKey}`;
    const group = `${rule.project_id}:${cand.subjectType}:${cand.subjectKey}`;
    const detection = { ...cand.result, ruleVersion: rule.current_version, evaluatedAt: now.toISOString(),
      reviewSteps: reviewSteps(cand, sev.severity) };
    const breakdown = { factors: sev.factors, caps: sev.caps, points: sev.points };
    const existing = (await c.query<IssueForNotification & { status: string; severity: Severity; last_notified_at: Date | null }>(
      `SELECT * FROM detected_issues WHERE dedup_key = $1 AND status <> 'closed' FOR UPDATE`, [dedup])).rows[0];
    const cfg = rule.config;
    const recipients = cfg.notify.recipientUserIds.length ? cfg.notify.recipientUserIds : rule.owner_user_id ? [rule.owner_user_id] : [];
    const deliveries: string[] = []; const webhooks: string[] = [];
    const notify = async (issue: IssueForNotification, kind: 'detected' | 'severity_changed' | 'reopened', marker: string) => {
      const r = await this.notifications.plan(c, issue, kind, marker, cfg, recipients);
      deliveries.push(...r.deliveryIds); webhooks.push(...r.webhookDeliveryIds);
    };
    const addEvidence = async (issueId: string) => {
      let added = 0;
      for (const r of cand.evidence.slice(0, 500)) {
        const x = await c.query(`INSERT INTO alert_evidence (tenant_id, issue_id, mention_id, cluster_id, is_syndicated, added_at) VALUES ($1,$2,$3,$4,$5,$6)
          ON CONFLICT (issue_id, mention_id) DO NOTHING`, [tenantId, issueId, r.id, r.clusterId, r.syndicated, now]);
        added += x.rowCount ?? 0;
      }
      return added;
    };
    const cooldownOk = (last: Date | null) => !last || now.getTime() - last.getTime() >= cfg.cooldownMinutes * 60_000;

    if (!existing) {
      // Cooldown also spans a closed predecessor with the same dedup key (repeated events).
      const prev = (await c.query<{ last: Date | null }>(`SELECT max(last_notified_at) AS last FROM detected_issues WHERE dedup_key = $1`, [dedup])).rows[0]?.last ?? null;
      const issue = (await c.query<IssueForNotification>(
        `INSERT INTO detected_issues (tenant_id, project_id, rule_id, rule_version, scope, signal, subject_type, subject_key, dedup_key, group_key, title,
           status, severity, severity_points, severity_breakdown, detection, first_detected_at, last_detected_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'detected',$12,$13,$14,$15,$16,$16) RETURNING *`,
        [tenantId, rule.project_id, rule.id, rule.current_version, cand.scope, cand.signal, cand.subjectType, cand.subjectKey, dedup, group, cand.title.slice(0, 300),
          sev.severity, sev.points, JSON.stringify(breakdown), JSON.stringify(detection), now])).rows[0]!;
      await addEvidence(issue.id);
      await this.event(c, tenantId, issue.id, 'detected', null, 'detected', { severity: sev.severity, method: cand.result.method, exceeded: cand.result.exceeded, ruleVersion: rule.current_version,
        repeatOf: prev ? 'an earlier, closed issue with the same rule and subject' : null });
      if (cooldownOk(prev)) await notify(issue, 'detected', '0');
      await c.query(`UPDATE detected_issues SET status = 'pending_review', updated_at = $2 WHERE id = $1`, [issue.id, now]);
      await this.event(c, tenantId, issue.id, 'status_changed', 'detected', 'pending_review', { reason: 'awaiting analyst review' });
      return { action: 'created' as const, issueId: issue.id, deliveries, webhooks };
    }

    const added = await addEvidence(existing.id);
    const higher = severityRank(sev.severity) > severityRank(existing.severity);
    if (added === 0 && !higher) return { action: 'unchanged' as const, issueId: existing.id, deliveries, webhooks };
    let action: 'updated' | 'reopened' = 'updated';
    await c.query(
      `UPDATE detected_issues SET last_detected_at = $2, occurrence_count = occurrence_count + CASE WHEN $3 > 0 THEN 1 ELSE 0 END, detection = $4,
         severity_breakdown = CASE WHEN $5 THEN $6::jsonb ELSE severity_breakdown END, severity = CASE WHEN $5 THEN $7 ELSE severity END,
         severity_points = CASE WHEN $5 THEN $8 ELSE severity_points END, rule_version = $9, updated_at = $2 WHERE id = $1`,
      [existing.id, now, added, JSON.stringify(detection), higher, JSON.stringify(breakdown), sev.severity, sev.points, rule.current_version]);
    if (added) await this.event(c, tenantId, existing.id, 'redetected', null, null, { newEvidence: added, ruleVersion: rule.current_version });
    if (higher) await this.event(c, tenantId, existing.id, 'severity_changed', null, null, { from: existing.severity, to: sev.severity, points: sev.points });
    if (existing.status === 'resolved' && added > 0) {
      action = 'reopened';
      await c.query(`UPDATE detected_issues SET status = 'pending_review', resolved_at = NULL, updated_at = $2 WHERE id = $1`, [existing.id, now]);
      await this.event(c, tenantId, existing.id, 'reopened', 'resolved', 'pending_review', { reason: `${added} new supporting record(s) after resolution`, automatic: true });
    }
    const issue = (await c.query<IssueForNotification>('SELECT * FROM detected_issues WHERE id = $1', [existing.id])).rows[0]!;
    if (higher) await notify(issue, 'severity_changed', `${sev.severity}`);
    else if (action === 'reopened' && cooldownOk(existing.last_notified_at)) await notify(issue, 'reopened', String(issue.occurrence_count));
    return { action, issueId: existing.id, deliveries, webhooks };
  }

  /** Escalates unacknowledged issues per the rule version that created them; one notification per escalation level. */
  async escalate(c: PoolClient, tenantId: string, now: Date) {
    const deliveries: string[] = []; const webhooks: string[] = [];
    const open = (await c.query<IssueForNotification & { escalation_level: number; rule_id: string; rule_version: number; config: unknown }>(
      `SELECT i.*, v.config FROM detected_issues i JOIN alert_rule_versions v ON v.rule_id = i.rule_id AND v.version = i.rule_version
       WHERE i.status IN ('detected','pending_review') AND i.acknowledged_at IS NULL`)).rows;
    for (const i of open) {
      const cfg = RuleConfigSchema.parse(i.config);
      const steps = cfg.escalation?.steps ?? [];
      const age = (now.getTime() - new Date(i.first_detected_at).getTime()) / 60_000;
      let level = i.escalation_level;
      while (level < steps.length && age >= steps[level]!.afterMinutes) {
        const step = steps[level]!; level++;
        await c.query('UPDATE detected_issues SET escalation_level = $2, updated_at = $3 WHERE id = $1', [i.id, level, now]);
        await this.event(c, tenantId, i.id, 'escalated', null, null, { level, afterMinutes: step.afterMinutes, notifyUserIds: step.notifyUserIds });
        const r = await this.notifications.plan(c, { ...i, status: i.status }, 'escalated', String(level), cfg, step.notifyUserIds, { escalationLevel: level });
        deliveries.push(...r.deliveryIds); webhooks.push(...r.webhookDeliveryIds);
      }
    }
    return { deliveries, webhooks };
  }

  async event(c: PoolClient, tenantId: string, issueId: string, event: string, from: string | null, to: string | null, details: Record<string, unknown>, actor: string | null = null) {
    await c.query(`INSERT INTO alert_events (tenant_id, issue_id, event, from_status, to_status, actor_user_id, details, at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [tenantId, issueId, event, from, to, actor, JSON.stringify(details), this.clock.now()]);
  }
}

/** Analyst checklist stored with each detection; stricter for high and critical issues. */
export function reviewSteps(c: Candidate, severity: Severity): string[] {
  const steps = ['Open the supporting records and confirm they describe the same event or subject.',
    'Check whether coverage is independent: syndicated copies and one publisher\'s follow-ups are not confirmation.'];
  if (c.result.limitations.length) steps.push('Read the confidence limitations before relying on the numbers.');
  if (c.signal === 'negative_shift') steps.push('Tone labels are automated estimates: read a sample of the negative records.');
  if (severityRank(severity) >= severityRank('high')) {
    steps.push('Verify the key facts with the original publishers or official statements before any public response.',
      'Assign an owner and record the decision and its basis in the investigation notes.');
  }
  return steps;
}
