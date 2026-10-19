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

@Module({ imports: [DatabaseModule, IngestionCoreModule] })
class WorkerModule {}

/**
 * Ingestion worker: runs the BullMQ consumer, the DB-driven scheduler and a heartbeat.
 *   REDIS_URL=… DATABASE_URL=… node dist/worker.js        (or: npm run worker -w apps/api)
 * Flags: --no-scheduler (consumer only), --no-consumer (scheduler only).
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
  const analysisWorker = runConsumer && !process.argv.includes('--no-analysis')
    ? createAnalysisWorker({ config, analysis: ctx.get(AnalysisService), summaries: ctx.get(SummariesService), enqueuer: ctx.get(AnalysisEnqueuer), redis, provider })
    : null;
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
  if (runScheduler) void tick();
  logEvent('info', 'ingestion.worker_started', { id, consumer: runConsumer, scheduler: runScheduler, concurrency: config.ingestion.workerConcurrency });

  const shutdown = async (signal: string) => {
    logEvent('info', 'ingestion.worker_stopping', { id, signal });
    if (scheduler) clearInterval(scheduler);
    clearInterval(heartbeat);
    await consumer?.worker.close();   // waits for in-flight jobs
    await analysisWorker?.close();
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
