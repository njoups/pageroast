import { Inject, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { Job, Queue, UnrecoverableError, Worker } from 'bullmq';
import { AlertsCoreModule } from '../alerts/alerts-queue';
import type { Clock } from '../alerts/clock';
import { refreshAnalytics } from '../analytics/refresh';
import { nextRunAt, previousPeriod, type Frequency } from '../analytics/tz';
import { AuditService } from '../audit/audit.service';
import { AppConfig, CONFIG } from '../config';
import { Database } from '../database/database.service';
import { EXECUTIVE_TEMPLATES } from '../commercial/catalog';
import { consume, loadEntitlements } from '../commercial/quota';
import { IngestionCoreModule } from '../ingestion/ingestion-core.module';
import { logEvent } from '../ingestion/log';
import { KEY_PREFIX, redisConnection } from '../ingestion/queue';
import { ReportGenerator, SYS } from './generator.service';

export const REPORTS_QUEUE_NAME = 'reports';
export const REPORTS_QUEUE = Symbol('REPORTS_QUEUE');
export type ReportJob = { type: 'generate'; tenantId: string; runId: string };

@Injectable()
export class ReportsEnqueuer {
  constructor(@Inject(REPORTS_QUEUE) private readonly queue: Queue<ReportJob> | null) {}
  get available() { return !!this.queue; }
  /** Job id = run id + attempt count, so a re-queue after a crash is a new job and duplicates of a live job collapse. */
  async generate(tenantId: string, runId: string, attempts = 0) {
    await this.queue?.add('generate', { type: 'generate', tenantId, runId }, { jobId: `rr_${runId}_${attempts}` });
  }
}

@Injectable()
class ReportsQueueLifecycle implements OnModuleDestroy {
  constructor(@Inject(REPORTS_QUEUE) private readonly queue: Queue | null) {}
  async onModuleDestroy() { await this.queue?.close(); }
}

@Module({
  imports: [IngestionCoreModule, AlertsCoreModule],
  providers: [
    {
      provide: REPORTS_QUEUE, inject: [CONFIG],
      useFactory: (c: AppConfig) => (c.redisUrl ? new Queue<ReportJob>(REPORTS_QUEUE_NAME, {
        connection: redisConnection(c.redisUrl), prefix: KEY_PREFIX,
        defaultJobOptions: { attempts: c.reports.attempts, backoff: { type: 'exponential', delay: 30_000 }, removeOnComplete: { age: 86_400, count: 5_000 }, removeOnFail: { age: 7 * 86_400 } },
      }) : null),
    },
    AuditService, ReportsEnqueuer, ReportGenerator, ReportsQueueLifecycle,
  ],
  exports: [REPORTS_QUEUE, ReportsEnqueuer, ReportGenerator],
})
export class ReportsCoreModule {}

/** Report generation consumer. Low concurrency: rendering is CPU-bound and runs are rate-limited per tenant anyway. */
export function createReportsWorker(d: { config: AppConfig; generator: ReportGenerator }): Worker<ReportJob> {
  const worker = new Worker<ReportJob>(REPORTS_QUEUE_NAME, async (job: Job<ReportJob>) => {
    const final = job.attemptsMade + 1 >= (job.opts.attempts ?? d.config.reports.attempts);
    const r = await d.generator.generate(job.data.tenantId, job.data.runId, final);
    if (r.status === 'failed') throw new UnrecoverableError(r.error ?? 'failed');
    return r;
  }, { connection: redisConnection(d.config.redisUrl!), prefix: KEY_PREFIX, concurrency: 2 });
  worker.on('error', (e) => logEvent('error', 'reports.worker_error', { message: e.message }));
  return worker;
}

/**
 * Report scheduler tick (worker, every minute):
 *  - due schedules → one run per (schedule, period) — the idempotency key makes repeated ticks and restarts harmless;
 *    the period is derived from the scheduled time in the schedule's time zone, so a late tick reports the same period;
 *  - queued runs without a live job are re-queued (crash recovery);
 *  - abandoned runs (running without heartbeat) fail; runs queued too long are cancelled;
 *  - expired artifacts are deleted (metadata kept).
 */
export async function reportsSchedulerTick(db: Database, enqueuer: ReportsEnqueuer, generator: ReportGenerator, config: AppConfig, clock: Clock) {
  const now = clock.now();
  const due = await db.withSystem(async (c) => (await c.query<{ id: string; tenant_id: string }>(
    `SELECT id, tenant_id FROM report_schedules WHERE is_active AND cancelled_at IS NULL AND next_run_at <= $1 ORDER BY next_run_at LIMIT 200`, [now])).rows);
  let created = 0;
  for (const s of due) {
    const res = await db.withTenant(s.tenant_id, SYS, async (c) => {
      const sch = (await c.query(`SELECT s.*, d.deleted_at AS def_deleted FROM report_schedules s JOIN report_definitions d ON d.id = s.definition_id
        WHERE s.id = $1 AND s.is_active AND s.cancelled_at IS NULL AND s.next_run_at <= $2 FOR UPDATE OF s SKIP LOCKED`, [s.id, now])).rows[0];
      if (!sch) return null;
      const spec = { frequency: sch.frequency as Frequency, timeOfDay: sch.time_of_day, dayOfWeek: sch.day_of_week, dayOfMonth: sch.day_of_month, periodDays: sch.period_days, timezone: sch.timezone };
      // Missed occurrences (worker down) are not back-filled: the next run is computed from now.
      const next = nextRunAt(spec, now > sch.next_run_at ? now : sch.next_run_at);
      if (sch.def_deleted) { await c.query('UPDATE report_schedules SET is_active = false, cancelled_at = $2 WHERE id = $1', [s.id, now]); return null; }
      const period = previousPeriod(spec.frequency, sch.next_run_at, spec.timezone, spec.periodDays ?? 7);
      const key = `${s.id}:${period.start.toISOString()}`;
      const today = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM report_runs WHERE queued_at > $1`, [new Date(now.getTime() - 86_400_000)])).rows[0]!.n;
      const def = (await c.query('SELECT template, project_id FROM report_definitions WHERE id = $1', [sch.definition_id])).rows[0];
      // Commercial gates (plan status, features, plan quota). A blocked run is created and then failed with the reason
      // (visible to its recipients), never silently dropped.
      const ent = await loadEntitlements(c, s.tenant_id, now);
      let block: string | null = today >= config.reports.runsPerDay ? `Daily report quota (${config.reports.runsPerDay}) reached` : null;
      if (!block && ent.access !== 'full') block = `Subscription is ${ent.subscription?.status ?? 'missing'}; scheduled reports are paused`;
      if (!block && !ent.features.scheduled_reports) block = 'Scheduled reports are not included in the plan';
      if (!block && EXECUTIVE_TEMPLATES.has(def.template) && !ent.features.executive_analytics) block = 'This report template is not included in the plan';
      const ins = await c.query<{ id: string }>(`INSERT INTO report_runs (tenant_id, definition_id, schedule_id, template, template_version, period_start, period_end, timezone, idempotency_key, trigger, status, requested_by, queued_at)
        VALUES ($1,$2,$3,$4,'pending',$5,$6,$7,$8,'schedule','queued',$9,$10) ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING id`,
        [s.tenant_id, sch.definition_id, s.id, def.template, period.start, period.end, spec.timezone, key, sch.created_by, now]);
      if (ins.rows[0] && !block) {
        const u = await consume(c, s.tenant_id, { metric: 'reports_generated', quantity: 1, idempotencyKey: `report_run:${ins.rows[0].id}`, source: 'report_schedule', occurredAt: now, projectId: def.project_id }, { enforce: true, ent });
        if (!u.recorded && !u.duplicate) block = `Plan limit reached. ${u.decision.reason}`;
      }
      await c.query('UPDATE report_schedules SET next_run_at = $2, last_run_at = $3 WHERE id = $1', [s.id, next, now]);
      return ins.rows[0] ? { runId: ins.rows[0].id, block, createdBy: sch.created_by as string | null } : null;
    });
    if (!res) continue;
    created++;
    if (res.block) await generator.fail({ id: res.runId, tenant_id: s.tenant_id, schedule_id: s.id, requested_by: null, def_created_by: res.createdBy }, res.block);
    else await enqueuer.generate(s.tenant_id, res.runId);
  }
  // Recovery and hygiene.
  const stale = await db.withSystem(async (c) => (await c.query<{ id: string; tenant_id: string; status: string; attempts: number; schedule_id: string | null; requested_by: string | null; queued_at: Date }>(
    `SELECT id, tenant_id, status, attempts, schedule_id, requested_by, queued_at FROM report_runs
     WHERE (status = 'running' AND coalesce(heartbeat_at, started_at) < $1)
        OR (status = 'queued' AND queued_at < $2 AND (heartbeat_at IS NULL OR heartbeat_at < $3)) LIMIT 200`,
    [new Date(now.getTime() - config.reports.staleRunMinutes * 60_000), new Date(now.getTime() - 2 * 60_000), new Date(now.getTime() - 10 * 60_000)])).rows);
  let abandoned = 0; let requeued = 0;
  for (const r of stale) {
    if (r.status === 'running') {
      await generator.fail({ ...r, def_created_by: null }, `Abandoned: the worker stopped responding for more than ${config.reports.staleRunMinutes} minutes`); abandoned++;
    } else if (now.getTime() - r.queued_at.getTime() > config.reports.queuedTimeoutMinutes * 60_000) {
      await db.withTenant(r.tenant_id, SYS, (c) => c.query(`UPDATE report_runs SET status = 'cancelled', error = $2, finished_at = $3 WHERE id = $1 AND status = 'queued'`,
        [r.id, `Not started within ${config.reports.queuedTimeoutMinutes} minutes`, now])); abandoned++;
    } else { await enqueuer.generate(r.tenant_id, r.id, r.attempts); requeued++; }
  }
  const expiring = await db.withSystem(async (c) => (await c.query<{ tenant_id: string }>(
    `SELECT DISTINCT tenant_id FROM report_artifacts WHERE data IS NOT NULL AND expires_at <= $1`, [now])).rows);
  let expired = 0;
  for (const t of expiring) {
    expired += (await db.withTenant(t.tenant_id, SYS, (c) => c.query(`UPDATE report_artifacts SET data = NULL, expired_at = $1 WHERE data IS NOT NULL AND expires_at <= $1`, [now]))).rowCount ?? 0;
  }
  return { due: due.length, created, requeued, abandoned, expired };
}

/** Incremental analytics aggregation for every tenant; also drops expired cache entries. */
export async function analyticsRefreshTick(db: Database, clock: Clock) {
  const tenants = await db.withSystem(async (c) => (await c.query<{ id: string }>('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id));
  let changed = 0;
  for (const t of tenants) {
    try {
      const r = await db.withTenant(t, SYS, async (c) => {
        const out = await refreshAnalytics(c, t, clock.now());
        await c.query('DELETE FROM analytics_cache WHERE expires_at < $1', [new Date(clock.now().getTime() - 3_600_000)]);
        return out;
      });
      if (r.changed) changed++;
    } catch (e) { logEvent('error', 'analytics.refresh_failed', { tenantId: t, message: (e as Error).message.slice(0, 200) }); }
  }
  return { tenants: tenants.length, changed };
}
