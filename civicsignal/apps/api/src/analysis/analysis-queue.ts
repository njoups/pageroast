import { Inject, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { DelayedError, Job, Queue, UnrecoverableError, Worker } from 'bullmq';
import { AppConfig, CONFIG } from '../config';
import { Database } from '../database/database.service';
import { logEvent } from '../ingestion/log';
import { KEY_PREFIX, redisConnection, type Redis } from '../ingestion/queue';
import { AnalysisService, analysisKey } from './analysis.service';
import { ClusterService } from './cluster.service';
import { PROMPTS, promptSha256 } from './prompts';
import { ANALYSIS_PROVIDER, BaselineProvider, createProvider, FALLBACK_PROVIDER, type AnalysisProvider } from './providers';
import { ProviderError } from './providers/provider';
import { SummariesService } from './summaries.service';

export const ANALYSIS_QUEUE_NAME = 'analysis';
export const ANALYSIS_QUEUE = Symbol('ANALYSIS_QUEUE');
export type AnalysisJob =
  | { type: 'analyze'; tenantId: string; analysisId: string }
  | { type: 'project_summary'; tenantId: string; summaryId: string }
  | { type: 'cluster_summary'; tenantId: string; clusterId: string; version: number };

const SYS = '00000000-0000-0000-0000-000000000000';
export type AnalysisTrigger = 'ingestion' | 'manual' | 'backfill' | 'reprocess';

/**
 * Creates ledger rows (the idempotency anchor) and queues work. Ledger keys:
 *  - ingestion/backfill: one per mention per processing configuration (model + prompt + taxonomy + pipeline)
 *  - reprocess: additionally bucketed per minute, so repeated clicks collapse into one job
 */
@Injectable()
export class AnalysisEnqueuer {
  constructor(private readonly db: Database, @Inject(ANALYSIS_QUEUE) private readonly queue: Queue<AnalysisJob> | null,
    @Inject(ANALYSIS_PROVIDER) private readonly provider: AnalysisProvider) {}

  get available(): boolean { return !!this.queue; }

  async enqueueMentions(tenantId: string, mentionIds: string[], trigger: AnalysisTrigger, requestedBy: string | null = null): Promise<{ queued: string[]; skipped: number }> {
    if (!this.queue || mentionIds.length === 0) return { queued: [], skipped: mentionIds.length };
    const key = analysisKey(this.provider);
    const suffix = trigger === 'reprocess' || trigger === 'manual' ? `:${new Date().toISOString().slice(0, 16)}` : '';
    const ids = await this.db.withTenant(tenantId, requestedBy ?? SYS, async (c) => {
      if (trigger === 'ingestion') {
        const s = (await c.query<{ auto_analyze: boolean }>('SELECT auto_analyze FROM ai_tenant_settings')).rows[0];
        if (s && !s.auto_analyze) return [];
      }
      const r = await c.query<{ id: string; mention_id: string }>(
        `INSERT INTO mention_analyses (tenant_id, mention_id, idempotency_key, trigger, pipeline_version, requested_by)
         SELECT $1, m.id, $2 || ':' || $3 || $4, $3, 'ai-pipeline/1', $5 FROM mentions m WHERE m.id = ANY($6::uuid[])
         ON CONFLICT (tenant_id, mention_id, idempotency_key) DO NOTHING RETURNING id, mention_id`,
        [tenantId, key, trigger, suffix, requestedBy, mentionIds]);
      if (r.rows.length) await c.query(`UPDATE mentions SET processing_status = 'queued' WHERE id = ANY($1::uuid[]) AND processing_status <> 'running'`, [r.rows.map((x) => x.mention_id)]);
      return r.rows.map((x) => x.id);
    });
    for (const id of ids) await this.queue.add('analyze', { type: 'analyze', tenantId, analysisId: id }, { jobId: `an_${id}` });
    return { queued: ids, skipped: mentionIds.length - ids.length };
  }

  async enqueueProjectSummary(tenantId: string, summaryId: string) {
    if (!this.queue) return false;
    await this.queue.add('project_summary', { type: 'project_summary', tenantId, summaryId }, { jobId: `sm_${summaryId}` });
    return true;
  }

  async enqueueClusterSummary(tenantId: string, clusterId: string, version: number) {
    if (!this.queue) return false;
    await this.queue.add('cluster_summary', { type: 'cluster_summary', tenantId, clusterId, version }, { jobId: `cs_${clusterId}_v${version}`, delay: 30_000 });
    return true;
  }
}

@Injectable()
class AnalysisQueueLifecycle implements OnModuleDestroy {
  constructor(@Inject(ANALYSIS_QUEUE) private readonly queue: Queue | null) {}
  async onModuleDestroy() { await this.queue?.close(); }
}

@Module({
  providers: [
    { provide: ANALYSIS_PROVIDER, inject: [CONFIG], useFactory: (c: AppConfig) => createProvider(c) },
    { provide: FALLBACK_PROVIDER, useFactory: () => new BaselineProvider() },
    {
      provide: ANALYSIS_QUEUE, inject: [CONFIG],
      useFactory: (c: AppConfig) => (c.redisUrl ? new Queue<AnalysisJob>(ANALYSIS_QUEUE_NAME, {
        connection: redisConnection(c.redisUrl), prefix: KEY_PREFIX,
        defaultJobOptions: { attempts: c.ai.attempts, backoff: { type: 'jittered' }, removeOnComplete: { age: 7 * 86400, count: 20_000 }, removeOnFail: { age: 30 * 86400 } },
      }) : null),
    },
    AnalysisEnqueuer, AnalysisService, ClusterService, SummariesService, AnalysisQueueLifecycle,
  ],
  exports: [ANALYSIS_PROVIDER, FALLBACK_PROVIDER, ANALYSIS_QUEUE, AnalysisEnqueuer, AnalysisService, ClusterService, SummariesService],
})
export class AnalysisCoreModule {}

/** Records the prompt templates in use (hash detects edits that forgot a version bump). */
export async function registerPromptVersions(db: Database): Promise<void> {
  await db.withSystem(async (c) => {
    for (const p of Object.values(PROMPTS)) {
      const sha = promptSha256(p);
      const existing = (await c.query<{ sha256: string }>('SELECT sha256 FROM ai_prompt_versions WHERE id = $1', [p.id])).rows[0];
      if (existing && existing.sha256 !== sha) throw new Error(`Prompt ${p.id} text changed without a version bump`);
      if (!existing) await c.query('INSERT INTO ai_prompt_versions (id, task, version, sha256, description) VALUES ($1,$2,$3,$4,$5)', [p.id, p.task, p.version, sha, p.description]);
    }
  });
}

export interface AnalysisWorkerDeps { config: AppConfig; analysis: AnalysisService; summaries: SummariesService; enqueuer: AnalysisEnqueuer; redis: Redis; provider: AnalysisProvider }

export function analysisBackoff(attemptsMade: number, baseMs: number, err?: Error, rand = Math.random): number {
  if (err instanceof ProviderError && err.opts.retryAfterMs) return Math.min(err.opts.retryAfterMs + Math.floor(rand() * 1000), 3600_000);
  return Math.round(Math.min(baseMs * 2 ** Math.max(attemptsMade - 1, 0), 30 * 60_000) * (0.7 + rand() * 0.6));
}

export function createAnalysisWorker(d: AnalysisWorkerDeps): Worker<AnalysisJob> {
  const worker = new Worker<AnalysisJob>(ANALYSIS_QUEUE_NAME, async (job: Job<AnalysisJob>, token?: string) => {
    // Provider rate gate (requests per minute across all workers); deferral does not consume an attempt.
    if (d.provider.method !== 'baseline' && job.data.type !== 'cluster_summary') {
      const k = `${KEY_PREFIX}:ai:rpm:${d.provider.name}:${Math.floor(Date.now() / 60_000)}`;
      const n = await d.redis.incr(k); if (n === 1) await d.redis.expire(k, 120);
      if (n > d.config.ai.requestsPerMinute) { await job.moveToDelayed(Date.now() + 60_000 - (Date.now() % 60_000) + 250, token); throw new DelayedError(); }
    }
    const attempt = job.attemptsMade + 1;
    const final = attempt >= (job.opts.attempts ?? d.config.ai.attempts);
    try {
      if (job.data.type === 'analyze') {
        const r = await d.analysis.run(job.data.tenantId, job.data.analysisId, attempt, final);
        if (r.clusterId && r.clusterVersion && d.provider.method !== 'baseline') await d.enqueuer.enqueueClusterSummary(job.data.tenantId, r.clusterId, r.clusterVersion);
        return r;
      }
      if (job.data.type === 'project_summary') return await d.summaries.generateProjectSummary(job.data.tenantId, job.data.summaryId);
      return await d.summaries.generateClusterSummary(job.data.tenantId, job.data.clusterId, job.data.version);
    } catch (e) {
      if (e instanceof ProviderError && !e.retryable) throw new UnrecoverableError(`${e.kind}: ${e.message}`);
      throw e;
    }
  }, {
    connection: redisConnection(d.config.redisUrl!), prefix: KEY_PREFIX, concurrency: d.config.ai.concurrency,
    settings: { backoffStrategy: (n: number, _t?: string, err?: Error) => analysisBackoff(n, d.config.ai.backoffBaseMs, err) },
  });
  worker.on('error', (e) => logEvent('error', 'analysis.worker_error', { message: e.message }));
  return worker;
}
