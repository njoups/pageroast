import 'reflect-metadata';
import { hostname } from 'node:os';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Queue } from 'bullmq';
import { AppConfig, CONFIG } from './config';
import { DatabaseModule } from './database/database.module';
import { Database } from './database/database.service';
import { INGESTION_QUEUE, IngestionCoreModule, REDIS } from './ingestion/ingestion-core.module';
import { logEvent } from './ingestion/log';
import { IngestionPipeline, type CollectJob } from './ingestion/pipeline.service';
import { createWorker, KEY_PREFIX, schedulerTick, type Redis } from './ingestion/queue';
import { AnalysisEnqueuer, createAnalysisWorker, registerPromptVersions } from './analysis/analysis-queue';
import { AnalysisService } from './analysis/analysis.service';
import { SummariesService } from './analysis/summaries.service';
import { ANALYSIS_PROVIDER, type AnalysisProvider } from './analysis/providers';
import { AlertsCoreModule, AlertsEnqueuer, alertsSchedulerTick, createAlertsWorker } from './alerts/alerts-queue';
import { EvaluatorService } from './alerts/evaluator.service';
import { IssueSummaryService } from './alerts/issue-summary.service';
import { NotificationService } from './alerts/notifications.service';
import { CLOCK, type Clock } from './alerts/clock';
import { ReportGenerator } from './reports/generator.service';
import { AuditService } from './audit/audit.service';
import { RetentionService, retentionTick } from './governance/retention.service';
import { analyticsRefreshTick, createReportsWorker, ReportsCoreModule, ReportsEnqueuer, reportsSchedulerTick } from './reports/reports-queue';

@Module({ imports: [DatabaseModule, IngestionCoreModule, AlertsCoreModule, ReportsCoreModule], providers: [AuditService, RetentionService] })
class WorkerModule {}

/**
 * Ingestion worker: runs the BullMQ consumer, the DB-driven scheduler and a heartbeat.
 *   REDIS_URL=… DATABASE_URL=… node dist/worker.js        (or: npm run worker -w apps/api)
 * Flags: --no-scheduler (consumer only), --no-consumer (scheduler only), --no-analysis, --no-alerts, --no-reports.
 */
async function main() {
  const ctx = await NestFactory.createApplicationContext(WorkerModule, { logger: ['error', 'warn'] });
  const config = ctx.get<AppConfig>(CONFIG);
  if (!config.redisUrl) throw new Error('REDIS_URL is required for the ingestion worker');
  const db = ctx.get(Database);
  const queue = ctx.get<Queue<CollectJob>>(INGESTION_QUEUE)!;
  const redis = ctx.get<Redis>(REDIS)!;
  const id = `${hostname()}:${process.pid}`;
  const runConsumer = !process.argv.includes('--no-consumer');
  const runScheduler = !process.argv.includes('--no-scheduler');

  await registerPromptVersions(db);
  const consumer = runConsumer ? createWorker({ config, db, pipeline: ctx.get(IngestionPipeline) }) : null;
  const provider = ctx.get<AnalysisProvider>(ANALYSIS_PROVIDER);
  const alertsEnqueuer = ctx.get(AlertsEnqueuer);
  const analysisWorker = runConsumer && !process.argv.includes('--no-analysis')
    ? createAnalysisWorker({ config, analysis: ctx.get(AnalysisService), summaries: ctx.get(SummariesService), enqueuer: ctx.get(AnalysisEnqueuer), redis, provider,
      // New analyses are evaluated shortly after (debounced by the per-bucket job id).
      onAnalyzed: (tenantId) => alertsEnqueuer.evaluate(tenantId, 'analysis', 30_000) })
    : null;
  const alertsWorker = runConsumer && !process.argv.includes('--no-alerts')
    ? createAlertsWorker({ config, evaluator: ctx.get(EvaluatorService), notifications: ctx.get(NotificationService), summaries: ctx.get(IssueSummaryService), enqueuer: alertsEnqueuer })
    : null;
  const generator = ctx.get(ReportGenerator); const reportsEnqueuer = ctx.get(ReportsEnqueuer); const clock = ctx.get<Clock>(CLOCK);
  const reportsWorker = runConsumer && !process.argv.includes('--no-reports') ? createReportsWorker({ config, generator }) : null;
  logEvent('info', 'alerts.channels', ctx.get(NotificationService).channelStatus());
  logEvent('info', 'analysis.provider', { provider: provider.name, model: provider.model, method: provider.method });
  const beat = () => redis.set(`${KEY_PREFIX}:worker:heartbeat:${id}`, JSON.stringify({ at: new Date().toISOString(), consumer: runConsumer, scheduler: runScheduler }), 'EX', 60);
  await beat();
  const heartbeat = setInterval(() => void beat().catch(() => undefined), 15_000);
  let ticking = false;
  const tick = async () => {
    if (ticking) return; ticking = true;
    try { await schedulerTick(db, queue); } catch (e) { logEvent('error', 'ingestion.scheduler_error', { message: (e as Error).message }); } finally { ticking = false; }
  };
  const scheduler = runScheduler ? setInterval(() => void tick(), config.ingestion.schedulerIntervalMs) : null;
  let alertsTicking = false;
  const alertsTick = async () => {
    if (alertsTicking) return; alertsTicking = true;
    try { await alertsSchedulerTick(db, alertsEnqueuer); } catch (e) { logEvent('error', 'alerts.scheduler_error', { message: (e as Error).message }); } finally { alertsTicking = false; }
  };
  const alertsScheduler = runScheduler ? setInterval(() => void alertsTick(), config.alerts.evaluateIntervalMs) : null;
  // Analytics aggregation and report scheduling (each guarded against overlapping runs).
  let analyticsTicking = false;
  const analyticsTick = async () => {
    if (analyticsTicking) return; analyticsTicking = true;
    try { await analyticsRefreshTick(db, clock); } catch (e) { logEvent('error', 'analytics.scheduler_error', { message: (e as Error).message }); } finally { analyticsTicking = false; }
  };
  let reportsTicking = false;
  const reportsTick = async () => {
    if (reportsTicking) return; reportsTicking = true;
    try {
      const r = await reportsSchedulerTick(db, reportsEnqueuer, generator, config, clock);
      if (r.created || r.abandoned || r.expired) logEvent('info', 'reports.scheduler', r);
    } catch (e) { logEvent('error', 'reports.scheduler_error', { message: (e as Error).message }); } finally { reportsTicking = false; }
  };
  let retentionTicking = false;
  const retentionRun = async () => {
    if (retentionTicking) return; retentionTicking = true;
    try { const r = await retentionTick(db, ctx.get(RetentionService), clock); if (r.ran) logEvent('info', 'retention.scheduler', r); }
    catch (e) { logEvent('error', 'retention.scheduler_error', { message: (e as Error).message }); } finally { retentionTicking = false; }
  };
  const retentionScheduler = runScheduler ? setInterval(() => void retentionRun(), 15 * 60_000) : null;
  const analyticsScheduler = runScheduler ? setInterval(() => void analyticsTick(), config.analytics.refreshIntervalMs) : null;
  const reportsScheduler = runScheduler ? setInterval(() => void reportsTick(), 60_000) : null;
  if (runScheduler) { void analyticsTick(); void reportsTick(); }
  if (runScheduler) void alertsTick();
  if (runScheduler) void tick();
  logEvent('info', 'ingestion.worker_started', { id, consumer: runConsumer, scheduler: runScheduler, concurrency: config.ingestion.workerConcurrency });

  const shutdown = async (signal: string) => {
    logEvent('info', 'ingestion.worker_stopping', { id, signal });
    if (scheduler) clearInterval(scheduler);
    if (alertsScheduler) clearInterval(alertsScheduler);
    if (analyticsScheduler) clearInterval(analyticsScheduler);
    if (reportsScheduler) clearInterval(reportsScheduler);
    if (retentionScheduler) clearInterval(retentionScheduler);
    clearInterval(heartbeat);
    await consumer?.worker.close();   // waits for in-flight jobs
    await analysisWorker?.close();
    await alertsWorker?.worker.close();
    await reportsWorker?.close();
    await alertsWorker?.dlq.close();
    await consumer?.dlq.close();
    consumer?.redis.disconnect();
    await redis.del(`${KEY_PREFIX}:worker:heartbeat:${id}`).catch(() => undefined);
    await ctx.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((e) => { logEvent('error', 'ingestion.worker_crashed', { message: (e as Error).message }); process.exit(1); });
