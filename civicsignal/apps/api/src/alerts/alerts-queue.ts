import { Inject, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { DelayedError, Job, Queue, UnrecoverableError, Worker } from 'bullmq';
import { AppConfig, CONFIG } from '../config';
import { Database } from '../database/database.service';
import { IngestionCoreModule } from '../ingestion/ingestion-core.module';
import { logEvent } from '../ingestion/log';
import { KEY_PREFIX, redisConnection } from '../ingestion/queue';
import { CLOCK, systemClock, type Clock } from './clock';
import { DeliveryError } from './channels/errors';
import { EvaluatorService } from './evaluator.service';
import { IssueSummaryService } from './issue-summary.service';
import { NotificationService } from './notifications.service';

export const ALERTS_QUEUE_NAME = 'alerts';
export const ALERTS_DLQ_NAME = 'alerts-dlq';
export const ALERTS_QUEUE = Symbol('ALERTS_QUEUE');
export const ALERTS_DLQ = Symbol('ALERTS_DLQ');
export type AlertJob =
  | { type: 'evaluate'; tenantId: string; trigger: string; bucket: string }
  | { type: 'deliver'; tenantId: string; deliveryId: string }
  | { type: 'webhook'; tenantId: string; deliveryId: string }
  | { type: 'issue_summary'; tenantId: string; issueId: string; marker: string };

/** Enqueues alert work; every job id is derived from its idempotency key, so duplicates collapse in the queue. */
@Injectable()
export class AlertsEnqueuer {
  constructor(@Inject(ALERTS_QUEUE) private readonly queue: Queue<AlertJob> | null, @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock) {}
  get available() { return !!this.queue; }

  bucket(now = this.clock.now()) { return String(Math.floor(now.getTime() / (this.config.alerts.bucketMinutes * 60_000))); }

  async evaluate(tenantId: string, trigger: string, delayMs = 0) {
    const bucket = this.bucket();
    await this.queue?.add('evaluate', { type: 'evaluate', tenantId, trigger, bucket }, { jobId: `ev_${tenantId}_${bucket}`, delay: delayMs });
  }
  async deliveries(tenantId: string, ids: string[], webhookIds: string[], retry = 0) {
    for (const id of ids) await this.queue?.add('deliver', { type: 'deliver', tenantId, deliveryId: id }, { jobId: `nd_${id}_${retry}` });
    for (const id of webhookIds) await this.queue?.add('webhook', { type: 'webhook', tenantId, deliveryId: id }, { jobId: `wd_${id}_${retry}` });
  }
  async summary(tenantId: string, issueId: string, marker: string) {
    await this.queue?.add('issue_summary', { type: 'issue_summary', tenantId, issueId, marker }, { jobId: `is_${issueId}_${marker}` });
  }
}

@Injectable()
class AlertsQueueLifecycle implements OnModuleDestroy {
  constructor(@Inject(ALERTS_QUEUE) private readonly queue: Queue | null, @Inject(ALERTS_DLQ) private readonly dlq: Queue | null) {}
  async onModuleDestroy() { await this.queue?.close(); await this.dlq?.close(); }
}

/** Queue health without tenant content: counts and the age of the oldest waiting job (lag). */
export async function queueHealth(q: Queue | null) {
  if (!q) return null;
  const counts = await q.getJobCounts('waiting', 'active', 'delayed', 'failed', 'prioritized');
  const oldest = (await q.getJobs(['waiting', 'prioritized'], 0, 0, true))[0];
  return { counts, lagSeconds: oldest ? Math.max(0, Math.round((Date.now() - oldest.timestamp) / 1000)) : 0 };
}

@Module({
  imports: [IngestionCoreModule],
  providers: [
    { provide: CLOCK, useValue: systemClock },
    {
      provide: ALERTS_QUEUE, inject: [CONFIG],
      useFactory: (c: AppConfig) => (c.redisUrl ? new Queue<AlertJob>(ALERTS_QUEUE_NAME, {
        connection: redisConnection(c.redisUrl), prefix: KEY_PREFIX,
        defaultJobOptions: { attempts: c.alerts.attempts, backoff: { type: 'jittered' }, removeOnComplete: { age: 86_400, count: 20_000 }, removeOnFail: { age: 7 * 86_400 } },
      }) : null),
    },
    { provide: ALERTS_DLQ, inject: [CONFIG], useFactory: (c: AppConfig) => (c.redisUrl ? new Queue(ALERTS_DLQ_NAME, { connection: redisConnection(c.redisUrl), prefix: KEY_PREFIX }) : null) },
    AlertsEnqueuer, EvaluatorService, NotificationService, IssueSummaryService, AlertsQueueLifecycle,
  ],
  exports: [CLOCK, ALERTS_QUEUE, ALERTS_DLQ, AlertsEnqueuer, EvaluatorService, NotificationService, IssueSummaryService],
})
export class AlertsCoreModule {}

export function alertsBackoff(attemptsMade: number, baseMs: number, err?: Error, rand = Math.random): number {
  return Math.round(Math.min(baseMs * 2 ** Math.max(attemptsMade - 1, 0), 60 * 60_000) * (0.7 + rand() * 0.6));
}

export interface AlertsWorkerDeps { config: AppConfig; evaluator: EvaluatorService; notifications: NotificationService; summaries: IssueSummaryService; enqueuer: AlertsEnqueuer }

/** One worker for evaluation, notification delivery, webhooks and issue summaries. Final failures go to the DLQ. */
export function createAlertsWorker(d: AlertsWorkerDeps): { worker: Worker<AlertJob>; dlq: Queue } {
  const connection = redisConnection(d.config.redisUrl!);
  const dlq = new Queue(ALERTS_DLQ_NAME, { connection, prefix: KEY_PREFIX });
  const worker = new Worker<AlertJob>(ALERTS_QUEUE_NAME, async (job: Job<AlertJob>, token?: string) => {
    const attempt = job.attemptsMade + 1;
    const final = attempt >= (job.opts.attempts ?? d.config.alerts.attempts);
    const data = job.data;
    try {
      if (data.type === 'evaluate') {
        const r = await d.evaluator.evaluateTenant(data.tenantId, data.trigger, { bucketKey: data.bucket });
        await d.enqueuer.deliveries(data.tenantId, r.deliveries, r.webhookDeliveries);
        for (const id of r.issuesTouched) await d.enqueuer.summary(data.tenantId, id, data.bucket);
        return { rules: r.rules, created: r.created, updated: r.updated };
      }
      if (data.type === 'issue_summary') return await d.summaries.generate(data.tenantId, data.issueId);
      const res = data.type === 'deliver'
        ? await d.notifications.deliver(data.tenantId, data.deliveryId, attempt, final)
        : await d.notifications.deliverWebhook(data.tenantId, data.deliveryId, attempt, final);
      if (res.outcome === 'delay') { await job.moveToDelayed(Date.now() + res.ms, token); throw new DelayedError(); }
      return res;
    } catch (e) {
      if (e instanceof DelayedError) throw e;
      const permanent = e instanceof DeliveryError && !e.retryable;
      if (permanent || final) {
        await dlq.add('dead', { job: data, attempts: attempt, error: (e as Error).message.slice(0, 500), at: new Date().toISOString() }, { jobId: `dlq_${job.id}` });
      }
      if (permanent) throw new UnrecoverableError((e as Error).message);
      throw e;
    }
  }, {
    connection, prefix: KEY_PREFIX, concurrency: 4,
    settings: { backoffStrategy: (n: number, _t?: string, err?: Error) => alertsBackoff(n, d.config.alerts.backoffBaseMs, err) },
  });
  worker.on('error', (e) => logEvent('error', 'alerts.worker_error', { message: e.message }));
  return { worker, dlq };
}

/**
 * Scheduler tick: queue an evaluation for every tenant with an active rule (one per bucket), and re-queue deliveries
 * that are due but have no live job (crash recovery, quiet hours ended).
 */
export async function alertsSchedulerTick(db: Database, enqueuer: AlertsEnqueuer): Promise<{ tenants: number; requeued: number }> {
  const tenants = await db.withSystem(async (c) => (await c.query<{ tenant_id: string }>(
    `SELECT DISTINCT tenant_id FROM alert_rules WHERE is_active AND deleted_at IS NULL`)).rows.map((r) => r.tenant_id));
  for (const t of tenants) await enqueuer.evaluate(t, 'schedule');
  const due = await db.withSystem(async (c) => (await c.query<{ id: string; tenant_id: string; attempts: number; kind: string }>(
    `SELECT id, tenant_id, attempts, 'n' AS kind FROM notification_deliveries
       WHERE channel <> 'in_app' AND ((status = 'pending' AND created_at < now() - interval '2 minutes') OR (status = 'deferred' AND not_before <= now())
         OR (status = 'sending' AND claimed_at < now() - interval '15 minutes'))
     UNION ALL
     SELECT id, tenant_id, attempts, 'w' FROM webhook_deliveries WHERE (status = 'pending' AND created_at < now() - interval '2 minutes')
       OR (status = 'sending' AND claimed_at < now() - interval '15 minutes')
     LIMIT 500`)).rows);
  for (const r of due) {
    await enqueuer.deliveries(r.tenant_id, r.kind === 'n' ? [r.id] : [], r.kind === 'w' ? [r.id] : [], r.attempts + 1);
  }
  return { tenants: tenants.length, requeued: due.length };
}
