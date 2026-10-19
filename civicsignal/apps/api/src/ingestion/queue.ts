import { randomUUID } from 'node:crypto';
import { DelayedError, Job, Queue, UnrecoverableError, Worker, type ConnectionOptions } from 'bullmq';
import IORedis from 'ioredis';
import type { AppConfig } from '../config';
import type { Database } from '../database/database.service';
import { ConnectorError } from './connectors/connector';
import { logEvent } from './log';
import type { CollectJob, IngestionPipeline } from './pipeline.service';

export const QUEUE = 'ingestion';
export const DLQ = 'ingestion-dlq';
export const KEY_PREFIX = 'cs';

export function redisConnection(url: string): ConnectionOptions {
  const u = new URL(url);
  return {
    host: u.hostname, port: Number(u.port || 6379), username: u.username || undefined, password: u.password ? decodeURIComponent(u.password) : undefined,
    db: u.pathname.length > 1 ? Number(u.pathname.slice(1)) : 0, tls: u.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: null,
  };
}

/** BullMQ job ids are the idempotency keys; ':' is not allowed in custom ids. */
export const jobIds = {
  scheduled: (sourceId: string, dueAt: Date) => `sched_${sourceId}_${Math.floor(dueAt.getTime() / 1000)}`,
  manual: (sourceId: string) => `manual_${sourceId}_${randomUUID()}`,
  retry: (runId: string) => `retry_${runId}`,
};

/** Exponential backoff with ±30% jitter, capped at 30 minutes; a provider's Retry-After wins when present. */
export function backoffDelay(attemptsMade: number, baseMs: number, err?: Error, rand = Math.random): number {
  const ra = err instanceof ConnectorError ? err.opts.retryAfterMs : undefined;
  if (ra !== undefined) return Math.min(ra + Math.floor(rand() * 1000), 6 * 3600 * 1000);
  const exp = Math.min(baseMs * 2 ** Math.max(attemptsMade - 1, 0), 30 * 60 * 1000);
  return Math.round(exp * (0.7 + rand() * 0.6));
}

export function createQueue(config: AppConfig): Queue<CollectJob> {
  if (!config.redisUrl) throw new Error('REDIS_URL is not configured');
  return new Queue<CollectJob>(QUEUE, {
    connection: redisConnection(config.redisUrl), prefix: KEY_PREFIX,
    defaultJobOptions: {
      attempts: config.ingestion.attempts, backoff: { type: 'jittered' },
      removeOnComplete: { age: 7 * 24 * 3600, count: 10_000 }, removeOnFail: { age: 30 * 24 * 3600 },
    },
  });
}

export async function enqueueCollect(queue: Queue<CollectJob>, job: CollectJob): Promise<void> {
  await queue.add('collect', job, { jobId: job.idempotencyKey });
}

export type Redis = IORedis;
interface GateDeps { redis: Redis; config: AppConfig }

/**
 * Pre-run gates (no attempt is consumed when a gate defers the job):
 *  - per-source lock: one collection per source at a time (per-source concurrency = 1)
 *  - per-host spacing: politeness across all tenants (e.g. GDELT: 1 request / 6 s)
 *  - per-source rate limit (requests per minute) and daily quota from the source registry
 */
export async function acquireGates(d: GateDeps, sourceId: string, host: string | null, limits: { perMinute: number | null; perDay: number | null }, token: string)
  : Promise<{ ok: true } | { ok: false; delayMs: number; reason: string }> {
  const lockKey = `${KEY_PREFIX}:lock:source:${sourceId}`;
  if ((await d.redis.set(lockKey, token, 'PX', 10 * 60 * 1000, 'NX')) !== 'OK') return { ok: false, delayMs: 15_000, reason: 'source_busy' };
  const release = () => releaseLock(d.redis, lockKey, token);
  if (host) {
    const spacing = d.config.ingestion.hostSpacingMs[host] ?? d.config.ingestion.defaultHostSpacingMs;
    if (spacing > 0 && (await d.redis.set(`${KEY_PREFIX}:host:${host}`, '1', 'PX', spacing, 'NX')) !== 'OK') {
      const ttl = await d.redis.pttl(`${KEY_PREFIX}:host:${host}`);
      await release();
      return { ok: false, delayMs: Math.max(ttl, 250), reason: 'host_spacing' };
    }
  }
  const now = new Date();
  if (limits.perMinute) {
    const k = `${KEY_PREFIX}:rpm:${sourceId}:${Math.floor(now.getTime() / 60000)}`;
    const n = await d.redis.incr(k); if (n === 1) await d.redis.expire(k, 120);
    if (n > limits.perMinute) { await release(); return { ok: false, delayMs: 60_000 - (now.getTime() % 60000), reason: 'source_rate_limit' }; }
  }
  if (limits.perDay) {
    const k = `${KEY_PREFIX}:rpd:${sourceId}:${now.toISOString().slice(0, 10)}`;
    const n = await d.redis.incr(k); if (n === 1) await d.redis.expire(k, 2 * 86400);
    if (n > limits.perDay) {
      await release();
      const tomorrow = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
      return { ok: false, delayMs: tomorrow - now.getTime(), reason: 'source_daily_quota' };
    }
  }
  return { ok: true };
}

/** Live worker heartbeats (SCAN, not KEYS, so Redis is never blocked). */
export async function workerHeartbeats(redis: Redis): Promise<Array<{ id: string; at?: string; consumer?: boolean; scheduler?: boolean }>> {
  const out: Array<{ id: string }> = [];
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${KEY_PREFIX}:worker:heartbeat:*`, 'COUNT', 100);
    cursor = next;
    for (const k of keys) out.push({ id: k.split(':').slice(3).join(':'), ...JSON.parse((await redis.get(k)) ?? '{}') });
  } while (cursor !== '0');
  return out;
}

export function releaseLock(redis: Redis, key: string, token: string): Promise<unknown> {
  return redis.eval(`if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`, 1, key, token);
}

export interface WorkerDeps { config: AppConfig; db: Database; pipeline: IngestionPipeline }

/** Looks up what the gates need (host, limits) in tenant context. */
async function gateInfo(db: Database, job: CollectJob) {
  return db.withTenant(job.tenantId, '00000000-0000-0000-0000-000000000000', async (c) => {
    const r = await c.query<{ feed_url: string | null; kind: string; rate_limit_per_minute: number | null; quota_per_day: number | null }>(
      'SELECT s.feed_url, k.kind, s.rate_limit_per_minute, s.quota_per_day FROM sources s JOIN connectors k ON k.source_id = s.id WHERE s.id = $1', [job.sourceId]);
    return r.rows[0];
  });
}

export function createRedis(url: string): Redis {
  return new IORedis(url, { maxRetriesPerRequest: null, lazyConnect: false });
}

export function createWorker(deps: WorkerDeps): { worker: Worker<CollectJob>; dlq: Queue; redis: Redis } {
  const { config } = deps;
  const connection = redisConnection(config.redisUrl!);
  const dlq = new Queue(DLQ, { connection, prefix: KEY_PREFIX });
  const redis = createRedis(config.redisUrl!);
  const worker = new Worker<CollectJob>(QUEUE, async (job: Job<CollectJob>, token?: string) => {
    const info = await gateInfo(deps.db, job.data);
    const host = info ? (info.kind === 'gdelt' ? 'api.gdeltproject.org' : info.feed_url ? new URL(info.feed_url).hostname.toLowerCase() : null) : null;
    const lockToken = randomUUID();
    const gate = info
      ? await acquireGates({ redis, config }, job.data.sourceId, host, { perMinute: info.rate_limit_per_minute, perDay: info.quota_per_day }, lockToken)
      : { ok: true as const };
    if (!gate.ok) {
      logEvent('info', 'ingestion.deferred', { jobId: job.id, sourceId: job.data.sourceId, reason: gate.reason, delayMs: gate.delayMs });
      await job.moveToDelayed(Date.now() + gate.delayMs, token);
      throw new DelayedError();
    }
    const attempt = job.attemptsMade + 1;
    const maxAttempts = job.opts.attempts ?? config.ingestion.attempts;
    try {
      return await deps.pipeline.run(job.data, attempt, attempt >= maxAttempts);
    } catch (e) {
      const err = e instanceof ConnectorError ? e : new ConnectorError('network', (e as Error).message);
      const final = !err.retryable || attempt >= maxAttempts;
      if (final) {
        await dlq.add('dead', { job: job.data, jobId: job.id, attempts: attempt, error: { kind: err.kind, message: err.message }, at: new Date().toISOString() },
          { jobId: `dlq_${job.id}` });
      }
      if (!err.retryable) throw new UnrecoverableError(`${err.kind}: ${err.message}`);
      throw err;
    } finally {
      if (info) await releaseLock(redis, `${KEY_PREFIX}:lock:source:${job.data.sourceId}`, lockToken);
    }
  }, {
    connection, prefix: KEY_PREFIX, concurrency: config.ingestion.workerConcurrency,
    settings: { backoffStrategy: (attemptsMade: number, _type?: string, err?: Error) => backoffDelay(attemptsMade, config.ingestion.backoffBaseMs, err) },
  });
  worker.on('error', (e) => logEvent('error', 'ingestion.worker_error', { message: e.message }));
  return { worker, dlq, redis };
}

/**
 * Enqueues every due, active source exactly once per due time. Safe with several scheduler instances: rows are claimed
 * with FOR UPDATE SKIP LOCKED and job ids are deterministic, so BullMQ drops duplicates.
 */
export async function schedulerTick(db: Database, queue: Queue<CollectJob>, batch = 200): Promise<number> {
  const due = await db.withSystem(async (c) => (await c.query<{ source_id: string; tenant_id: string; due_at: Date }>(
    `WITH d AS (
       SELECT source_id, next_due_at AS due_at FROM ingestion_schedule
       WHERE active AND next_due_at <= now() ORDER BY next_due_at LIMIT $1 FOR UPDATE SKIP LOCKED)
     UPDATE ingestion_schedule s SET next_due_at = now() + make_interval(secs => s.interval_seconds)
     FROM d WHERE s.source_id = d.source_id RETURNING s.source_id, s.tenant_id, d.due_at`, [batch])).rows);
  for (const d of due) {
    await enqueueCollect(queue, { tenantId: d.tenant_id, sourceId: d.source_id, trigger: 'schedule', idempotencyKey: jobIds.scheduled(d.source_id, d.due_at) });
  }
  if (due.length) logEvent('info', 'ingestion.scheduled', { count: due.length });
  return due.length;
}
