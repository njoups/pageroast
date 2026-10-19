import { INestApplication } from '@nestjs/common';
import type { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { Client } from 'pg';
import request from 'supertest';
import { AppConfig, CONFIG } from '../../src/config';
import { Database } from '../../src/database/database.service';
import { INGESTION_DLQ, INGESTION_QUEUE } from '../../src/ingestion/ingestion-core.module';
import { IngestionPipeline, type CollectJob } from '../../src/ingestion/pipeline.service';
import { createWorker, enqueueCollect, KEY_PREFIX, schedulerTick } from '../../src/ingestion/queue';
import { OWNER_URL } from '../env';
import { createOrg, registerUser, testApp, TEST_REDIS_URL, TestUser } from '../helpers';
import { FeedServer, rss } from './feed-server';

/** BullMQ + real Redis (database 15, flushed) + real Postgres + local synthetic feed server. */
describe('ingestion queue and worker (e2e, Redis)', () => {
  let app: INestApplication; let srv: FeedServer; let redis: IORedis;
  let worker: Worker<CollectJob>; let dlqHandle: Queue; let queue: Queue<CollectJob>; let workerParts: ReturnType<typeof createWorker>;
  const http = () => request(app.getHttpServer());
  let owner: TestUser; let org: string; let owner_db: Client;
  const hitTimes: Record<string, number[]> = {};

  const until = async <T>(fn: () => Promise<T | null | undefined | false>, ms = 15000): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('condition not met in time'); await new Promise((r) => setTimeout(r, 100)); }
  };
  const runRow = (sourceId: string, status: string) => owner_db.query('SELECT * FROM connector_runs WHERE source_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT 1', [sourceId, status]).then((r) => r.rows[0]);
  const mkSource = async (path: string, extra: Record<string, unknown> = {}) => {
    const s = (await http().post(`/api/v1/organizations/${org}/sources`).set('Cookie', owner.cookie).send({
      kind: 'feed', name: `Q ${path} ${Math.random().toString(36).slice(2, 6)}`, feedUrl: srv.url(path), authorizationStatus: 'authorized', authorizationBasis: 'Synthetic local test feed', ...extra,
    }).expect(201)).body;
    return s.id as string;
  };
  const feed = (path: string, title: string) => srv.route(path, (_q, r) => { (hitTimes[path] ??= []).push(Date.now()); r.end(rss([{ title, link: `https://q.example${path}/${encodeURIComponent(title)}` }])); });

  beforeAll(async () => {
    redis = new IORedis(TEST_REDIS_URL, { maxRetriesPerRequest: null });
    await redis.flushdb();
    srv = await new FeedServer().start();
    feed('/ok-a', 'Item A'); feed('/ok-b', 'Item B'); feed('/spaced-1', 'Spaced one'); feed('/spaced-2', 'Spaced two'); feed('/rl', 'Rate limited'); feed('/sched', 'Scheduled item'); feed('/lock', 'Locked item');
    srv.route('/down', (_q, r) => { (hitTimes['/down'] ??= []).push(Date.now()); r.statusCode = 503; r.end(); });
    app = await testApp({
      INGESTION_ALLOW_PRIVATE_HOSTS: 'true', REDIS_URL: TEST_REDIS_URL, INGESTION_ATTEMPTS: '3', INGESTION_BACKOFF_BASE_MS: '200',
      INGESTION_DEFAULT_HOST_SPACING_MS: '0', INGESTION_HTTP_TIMEOUT_MS: '3000',
    });
    const config = app.get<AppConfig>(CONFIG);
    queue = app.get(INGESTION_QUEUE); dlqHandle = app.get(INGESTION_DLQ);
    workerParts = createWorker({ config, db: app.get(Database), pipeline: app.get(IngestionPipeline) });
    worker = workerParts.worker;
    owner_db = new Client({ connectionString: OWNER_URL }); await owner_db.connect();
    // Test files share one database: sources enabled by other files (whose feed servers are gone) must not be picked up by
    // the scheduler ticks below, or their failures would land in this file's dead-letter queue.
    await owner_db.query('UPDATE ingestion_schedule SET active = false');
    owner = await registerUser(app, 'Queue Owner');
    org = await createOrg(app, owner);
  });
  afterAll(async () => { await worker.close(); await workerParts.dlq.close(); workerParts.redis.disconnect(); await app.close(); await srv.close(); await owner_db.end(); redis.disconnect(); });

  it('collect-now queues a job that the worker completes; the run is visible through the API', async () => {
    const id = await mkSource('/ok-a');
    const r = await http().post(`/api/v1/organizations/${org}/sources/${id}/collect`).set('Cookie', owner.cookie).expect(202);
    expect(r.body.status).toBe('queued');
    const done = await until(() => runRow(id, 'succeeded'));
    expect(done.id).toBe(r.body.runId);                        // the queued row is the one completed (same idempotency key)
    expect(done).toMatchObject({ records_new: 1, trigger: 'manual' });
  });

  it('a scheduled job for a source that has since been disabled is skipped without fetching', async () => {
    const id = await mkSource('/ok-b?variant=disabled');
    const before = srv.hitsFor('/ok-b');
    const r = await app.get(IngestionPipeline).run({ tenantId: org, sourceId: id, trigger: 'schedule', idempotencyKey: `disabled_${id}` }, 1, false);
    expect(r).toEqual({ status: 'skipped_disabled', runId: null });
    expect(srv.hitsFor('/ok-b')).toBe(before);
  });

  it('identical job ids are de-duplicated by the queue', async () => {
    const id = await mkSource('/ok-b');
    const job: CollectJob = { tenantId: org, sourceId: id, trigger: 'manual', idempotencyKey: `dedupe_${id}` };
    await enqueueCollect(queue, job); await enqueueCollect(queue, job); await enqueueCollect(queue, job);
    await until(() => runRow(id, 'succeeded'));
    expect((await owner_db.query('SELECT count(*)::int n FROM connector_runs WHERE source_id = $1', [id])).rows[0].n).toBe(1);
    expect(srv.hitsFor('/ok-b')).toBe(1);
  });

  it('the scheduler enqueues each due source once, even with concurrent ticks', async () => {
    const id = await mkSource('/sched');
    await http().post(`/api/v1/organizations/${org}/sources/${id}/enable`).set('Cookie', owner.cookie).expect(200);
    const db = app.get(Database);
    const [a, b] = await Promise.all([schedulerTick(db, queue), schedulerTick(db, queue)]);
    expect(a + b).toBeGreaterThanOrEqual(1);
    await until(() => runRow(id, 'succeeded'));
    expect(await schedulerTick(db, queue)).toBe(0);              // next_due_at moved one interval ahead
    expect((await owner_db.query(`SELECT count(*)::int n FROM connector_runs WHERE source_id = $1 AND trigger = 'schedule'`, [id])).rows[0].n).toBe(1);
  });

  it('retries with backoff, then dead-letters; a failing source does not block a healthy one', async () => {
    const bad = await mkSource('/down');
    await http().post(`/api/v1/organizations/${org}/sources/${bad}/enable`).set('Cookie', owner.cookie).expect(200);
    const good = await mkSource('/spaced-1');
    await http().post(`/api/v1/organizations/${org}/sources/${bad}/collect`).set('Cookie', owner.cookie).expect(202);
    await http().post(`/api/v1/organizations/${org}/sources/${good}/collect`).set('Cookie', owner.cookie).expect(202);
    await until(() => runRow(good, 'succeeded'));
    const dead = await until(() => runRow(bad, 'dead_lettered'));
    expect(dead).toMatchObject({ attempt: 3, http_status: 503 });
    expect(hitTimes['/down']).toHaveLength(3);
    const gaps = hitTimes['/down']!.slice(1).map((t, i) => t - hitTimes['/down']![i]!);
    // Backoff grows: with a 200 ms base and ±30% jitter the gaps are 140–260 ms, then 280–520 ms (plus processing time).
    // Exact delays are unit-tested in dedup-health-secrets.spec.ts; this checks the real queue honours them.
    expect(gaps[0]!).toBeGreaterThanOrEqual(130);
    expect(gaps[1]!).toBeGreaterThan(gaps[0]!);
    const deadLetters = (await dlqHandle.getJobs(['waiting'])).filter((j) => j.data.job.sourceId === bad);
    expect(deadLetters).toHaveLength(1);
    const src = (await http().get(`/api/v1/organizations/${org}/sources/${bad}`).set('Cookie', owner.cookie)).body;
    expect(src).toMatchObject({ health: 'failing', consecutiveFailures: 3 });

    // Safe manual retry: one retry per failed run.
    srv.route('/down', (_q, r) => r.end(rss([{ title: 'Recovered', link: 'https://q.example/recovered' }])));
    await http().post(`/api/v1/organizations/${org}/sources/${bad}/runs/${dead.id}/retry`).set('Cookie', owner.cookie).expect(202);
    await http().post(`/api/v1/organizations/${org}/sources/${bad}/runs/${dead.id}/retry`).set('Cookie', owner.cookie).expect(409);
    const ok = await until(() => runRow(bad, 'succeeded'));
    expect(ok.trigger).toBe('retry');
    const healed = (await http().get(`/api/v1/organizations/${org}/sources/${bad}`).set('Cookie', owner.cookie)).body;
    expect(healed).toMatchObject({ consecutiveFailures: 0, lastError: null });
    await http().post(`/api/v1/organizations/${org}/sources/${bad}/runs/${ok.id}/retry`).set('Cookie', owner.cookie).expect(409);
  });

  it('per-source lock: a source already being collected is deferred, not run twice', async () => {
    const id = await mkSource('/lock');
    await redis.set(`${KEY_PREFIX}:lock:source:${id}`, 'someone-else', 'PX', 1500);
    await http().post(`/api/v1/organizations/${org}/sources/${id}/collect`).set('Cookie', owner.cookie).expect(202);
    await new Promise((r) => setTimeout(r, 700));
    expect(srv.hitsFor('/lock')).toBe(0);
    const job = (await queue.getJobs(['delayed']))[0];
    expect(job?.attemptsMade).toBe(0);                            // deferral does not consume a retry attempt
    await job!.promote();
    await new Promise((r) => setTimeout(r, 1000));
    await until(async () => { const j = (await queue.getJobs(['delayed']))[0]; if (j) await j.promote().catch(() => undefined); return runRow(id, 'succeeded'); }, 20000);
    expect(srv.hitsFor('/lock')).toBe(1);
  });

  it('per-source rate limit defers excess collections to the next minute', async () => {
    // The limiter uses fixed per-minute windows; both collects must land in the same window for the assertion to hold.
    const sec = new Date().getUTCSeconds();
    if (sec >= 50) await new Promise((r) => setTimeout(r, (61 - sec) * 1000));
    const id = await mkSource('/rl', { rateLimitPerMinute: 1 });
    await http().post(`/api/v1/organizations/${org}/sources/${id}/collect`).set('Cookie', owner.cookie).expect(202);
    await until(() => runRow(id, 'succeeded'));
    await http().post(`/api/v1/organizations/${org}/sources/${id}/collect`).set('Cookie', owner.cookie).expect(202);
    await new Promise((r) => setTimeout(r, 800));
    expect(srv.hitsFor('/rl')).toBe(1);
    expect((await queue.getJobs(['delayed'])).some((j) => j.data.sourceId === id)).toBe(true);
  });

  it('platform view reports queue depth and dead letters without tenant content', async () => {
    const admin = await registerUser(app, 'Ops Admin');
    await owner_db.query('UPDATE users SET is_platform_admin = true WHERE id = $1', [admin.id]);
    const r = await http().get('/api/v1/platform/ingestion').set('Cookie', admin.cookie).expect(200);
    expect(r.body).toMatchObject({ configured: true, deadLetter: { waiting: 1 } });
    expect(r.body.queue).toHaveProperty('delayed');
    await http().get('/api/v1/platform/ingestion').set('Cookie', owner.cookie).expect(403);
  });
});
