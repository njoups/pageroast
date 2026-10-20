import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { CLOCK, type Clock } from '../alerts/clock';
import { AuditService } from '../audit/audit.service';
import { Database } from '../database/database.service';
import { logEvent } from '../ingestion/log';
import { invalidateAnalytics, purgeMentions } from './purge';

const SYS = '00000000-0000-0000-0000-000000000000';
export const DATA_CLASSES = ['mention_body', 'mention_metadata', 'derived_analysis', 'reports', 'audit_events'] as const;
export type DataClass = (typeof DATA_CLASSES)[number];
/** Rows removed per class per pass; larger backlogs continue on the next pass, so one run never holds long locks. */
export const BATCH = 2000;
const OPEN_ISSUES = ['detected', 'pending_review', 'acknowledged', 'investigating'];

export interface RetentionResult { runId: string; status: string; dryRun: boolean; counts: Record<string, number>; policies: Record<string, number | null>; skippedReason?: string }

/**
 * Retention (docs/DATA_GOVERNANCE.md, "Retention"). Nothing is deleted unless an administrator has enabled retention for
 * the tenant; a legal hold suspends all deletion. Per data class:
 *  - mention_body:     article bodies older than N days are cleared (metadata kept);
 *  - mention_metadata: records older than N days are deleted with everything derived from them (see purge.ts),
 *                      except records that are evidence for an open issue;
 *  - source licence:   records past their source's retention period (mentions.retention_expires_at) are deleted the same way;
 *  - derived_analysis: superseded (non-current) analyses older than N days;
 *  - reports:          report runs (files, citations, deliveries) older than N days;
 *  - audit_events:     never deleted by the application (append-only); the count past N days is reported for operators.
 * Every pass (dry run or applied) is recorded in retention_runs and audited.
 */
@Injectable()
export class RetentionService {
  constructor(private readonly db: Database, private readonly audit: AuditService, @Inject(CLOCK) private readonly clock: Clock) {}

  async run(tenantId: string, o: { dryRun: boolean; trigger: 'schedule' | 'manual'; userId?: string | null }): Promise<RetentionResult> {
    const now = this.clock.now();
    return this.db.withTenant(tenantId, o.userId ?? SYS, async (c) => {
      // Serialise passes per tenant (manual run vs scheduler).
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('retention:' || $1))`, [tenantId]);
      const ctl = (await c.query<{ legal_hold: boolean; retention_enabled: boolean }>('SELECT legal_hold, retention_enabled FROM tenant_data_controls WHERE tenant_id = $1', [tenantId])).rows[0]
        ?? { legal_hold: false, retention_enabled: false };
      const pol = Object.fromEntries(DATA_CLASSES.map((k) => [k, null as number | null]));
      for (const r of (await c.query<{ data_class: DataClass; retention_days: number }>('SELECT data_class, retention_days FROM retention_policies')).rows) pol[r.data_class] = r.retention_days;
      const skipped = !o.dryRun && (ctl.legal_hold ? 'legal_hold' : !ctl.retention_enabled ? 'retention_disabled' : null);
      const run = (await c.query<{ id: string }>(`INSERT INTO retention_runs (tenant_id, trigger, dry_run, status, policies, requested_by, started_at)
        VALUES ($1,$2,$3,'running',$4,$5,$6) RETURNING id`, [tenantId, o.trigger, o.dryRun || !!skipped, JSON.stringify({ ...pol, legalHold: ctl.legal_hold }), o.userId ?? null, now])).rows[0]!.id;
      const counts = await this.evaluate(c, pol, now, o.dryRun || !!skipped);
      const status = skipped ? 'skipped' : 'succeeded';
      await c.query('UPDATE retention_runs SET status = $2, counts = $3, finished_at = $4, error = $5 WHERE id = $1', [run, status, JSON.stringify(counts), this.clock.now(), skipped || null]);
      const deleted = !o.dryRun && !skipped;
      await this.audit.record(c, { tenantId, actorUserId: o.userId ?? null, action: deleted ? 'retention.applied' : o.dryRun ? 'retention.previewed' : 'retention.skipped',
        targetType: 'retention_run', targetId: run, metadata: { trigger: o.trigger, counts, reason: skipped || undefined } });
      if (deleted && Object.values(counts).some((v) => v > 0)) logEvent('info', 'retention.applied', { tenantId, runId: run, counts });
      return { runId: run, status, dryRun: o.dryRun || !!skipped, counts, policies: pol, skippedReason: skipped || undefined };
    });
  }

  private async evaluate(c: PoolClient, pol: Record<string, number | null>, now: Date, dry: boolean): Promise<Record<string, number>> {
    const before = (days: number) => new Date(now.getTime() - days * 86_400_000);
    const counts: Record<string, number> = {};
    const keepEvidence = `NOT EXISTS (SELECT 1 FROM alert_evidence e JOIN detected_issues i ON i.id = e.issue_id WHERE e.mention_id = m.id AND i.status = ANY($2::text[]))`;
    let touched = false;

    // Records past their source licence's retention period.
    // Dry runs count everything eligible; applied runs process one batch per class (the rest follows next pass).
    const select = async (where: string, order: string, arg: Date) => (dry
      ? (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM mentions m WHERE ${where}`, [arg, OPEN_ISSUES])).rows[0]!.n
      : (await c.query<{ id: string }>(`SELECT m.id FROM mentions m WHERE ${where} ORDER BY ${order} LIMIT ${BATCH}`, [arg, OPEN_ISSUES])).rows.map((r) => r.id));
    const licence = await select(`m.retention_expires_at IS NOT NULL AND m.retention_expires_at <= $1 AND ${keepEvidence}`, 'm.retention_expires_at', now);
    counts.source_licence_expired = typeof licence === 'number' ? licence : licence.length;
    if (Array.isArray(licence) && licence.length) { await purgeMentions(c, licence, now, 'source licence retention'); touched = true; }

    if (pol.mention_metadata) {
      const old = await select(`m.discovered_at < $1 AND ${keepEvidence}`, 'm.discovered_at', before(pol.mention_metadata));
      counts.mentions_deleted = typeof old === 'number' ? old : old.length;
      if (Array.isArray(old) && old.length) { await purgeMentions(c, old, now, 'retention policy'); touched = true; }
    }
    if (pol.mention_body) {
      const sql = `FROM mentions WHERE body IS NOT NULL AND discovered_at < $1`;
      counts.bodies_cleared = dry ? (await c.query<{ n: number }>(`SELECT count(*)::int AS n ${sql}`, [before(pol.mention_body)])).rows[0]!.n
        : (await c.query(`UPDATE mentions SET body = NULL WHERE id IN (SELECT id ${sql} LIMIT ${BATCH})`, [before(pol.mention_body)])).rowCount ?? 0;
    }
    if (pol.derived_analysis) {
      const sql = `FROM mention_analyses WHERE NOT is_current AND coalesce(finished_at, queued_at) < $1`;
      counts.superseded_analyses_deleted = dry ? (await c.query<{ n: number }>(`SELECT count(*)::int AS n ${sql}`, [before(pol.derived_analysis)])).rows[0]!.n
        : (await c.query(`DELETE FROM mention_analyses WHERE id IN (SELECT id ${sql} LIMIT ${BATCH})`, [before(pol.derived_analysis)])).rowCount ?? 0;
      counts.superseded_summaries_deleted = dry ? (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ai_summaries WHERE NOT is_current AND created_at < $1`, [before(pol.derived_analysis)])).rows[0]!.n
        : (await c.query(`DELETE FROM ai_summaries WHERE id IN (SELECT id FROM ai_summaries WHERE NOT is_current AND created_at < $1 LIMIT ${BATCH})`, [before(pol.derived_analysis)])).rowCount ?? 0;
    }
    if (pol.reports) {
      const sql = `FROM report_runs WHERE queued_at < $1 AND status IN ('succeeded','failed','cancelled')`;
      counts.report_runs_deleted = dry ? (await c.query<{ n: number }>(`SELECT count(*)::int AS n ${sql}`, [before(pol.reports)])).rows[0]!.n
        : (await c.query(`DELETE FROM report_runs WHERE id IN (SELECT id ${sql} LIMIT ${BATCH})`, [before(pol.reports)])).rowCount ?? 0;
    }
    if (pol.audit_events) {
      counts.audit_events_past_retention = (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_events WHERE occurred_at < $1', [before(pol.audit_events)])).rows[0]!.n;
    }
    if (!dry && touched) await invalidateAnalytics(c);
    return counts;
  }
}

/** Worker tick: one scheduled pass per day for each tenant that enabled retention (legal holds are checked inside run()). */
export async function retentionTick(db: Database, retention: RetentionService, clock: Clock) {
  const tenants = await db.withSystem(async (c) => (await c.query<{ tenant_id: string }>(
    'SELECT tenant_id FROM tenant_data_controls WHERE retention_enabled AND NOT legal_hold')).rows.map((r) => r.tenant_id));
  let ran = 0;
  for (const t of tenants) {
    const last = await db.withTenant(t, SYS, async (c) => (await c.query<{ started_at: Date }>(
      `SELECT started_at FROM retention_runs WHERE trigger = 'schedule' AND status <> 'failed' ORDER BY started_at DESC LIMIT 1`)).rows[0]?.started_at);
    if (last && clock.now().getTime() - last.getTime() < 23 * 3_600_000) continue;
    try { await retention.run(t, { dryRun: false, trigger: 'schedule' }); ran++; }
    catch (e) { logEvent('error', 'retention.failed', { tenantId: t, message: (e as Error).message.slice(0, 200) }); }
  }
  return { tenants: tenants.length, ran };
}
