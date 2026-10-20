import { randomBytes, randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import type { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { Client } from 'pg';
import request from 'supertest';
import { CLOCK, type Clock } from '../../src/alerts/clock';
import * as E from '../../src/analytics/engine';
import { refreshAnalytics } from '../../src/analytics/refresh';
import { ANALYSIS_PROVIDER } from '../../src/analysis/providers';
import type { TestProvider } from '../../src/analysis/providers/test.provider';
import { AppConfig, CONFIG } from '../../src/config';
import { Database } from '../../src/database/database.service';
import { ARTICLE_COLUMNS } from '../../src/reports/csv';
import { ReportGenerator, SYS } from '../../src/reports/generator.service';
import { REPORTS_QUEUE, ReportsEnqueuer, reportsSchedulerTick } from '../../src/reports/reports-queue';
import { OWNER_URL } from '../env';
import { addMember, createOrg, registerUser, testApp, TEST_REDIS_URL, TestUser } from '../helpers';

/**
 * Analytics and executive reporting against real PostgreSQL and Redis. All records are synthetic fixtures (labelled in
 * their provenance); time comes from a controllable clock; AI commentary uses the deterministic test provider.
 * Reporting week under test: Mon 12 – Sun 18 Oct 2026, Asia/Jakarta = [2026-10-11T17:00Z, 2026-10-18T17:00Z).
 */
const NOW = Date.UTC(2026, 9, 19, 5, 0, 0);                 // Mon 19 Oct 12:00 WIB
const FROM = '2026-10-11T17:00:00.000Z'; const TO = '2026-10-18T17:00:00.000Z';
const PF = '2026-10-04T17:00:00.000Z';                       // previous equal period starts here

describe('analytics and reporting (e2e)', () => {
  let app: INestApplication; let db: Client; let redis: IORedis; let clock: Clock; let gen: ReportGenerator; let database: Database; let config: AppConfig;
  let provider: TestProvider;
  let t = NOW;
  const http = () => request(app.getHttpServer());
  let owner: TestUser; let analyst: TestUser; let viewer: TestUser; let unassigned: TestUser; let outsider: TestUser;
  let org: string; let otherOrg: string; let P: string; let Q: string; let qP: string; let qQ: string; let s1: string; let s2: string; let s3: string; let otherSource: string;
  let entA: string; let entB: string;
  const ids = {} as Record<string, string> & { m1: string; m2: string; m6: string };
  const api = (u: TestUser, o = () => org) => ({
    get: (p: string) => http().get(`/api/v1/organizations/${o()}${p}`).set('Cookie', u.cookie),
    post: (p: string, b: object = {}) => http().post(`/api/v1/organizations/${o()}${p}`).set('Cookie', u.cookie).send(b),
    patch: (p: string, b: object = {}) => http().patch(`/api/v1/organizations/${o()}${p}`).set('Cookie', u.cookie).send(b),
  });
  const wk = `from=${FROM}&to=${TO}`;

  async function mention(tenant: string, source: string, project: string | null, query: string | null, at: string, o: {
    title?: string; publisher?: string; label?: string; uncertain?: boolean; entities?: string[]; excerpt?: string; duplicateOf?: string; topics?: string[];
  } = {}) {
    const id = randomUUID();
    await db.query(`INSERT INTO mentions (id, tenant_id, source_id, url, canonical_url, title, excerpt, body, content_hash, publisher_domain, publisher, published_at, discovered_at, detected_language,
        duplicate_status, duplicate_of, provenance) VALUES ($1,$2,$3,$4,$4,$5,$6,'FULL BODY MUST NEVER BE EXPORTED',$7,$8,$8,$9,clock_timestamp(),'id',$10,$11,'{"fixture":"reports.e2e synthetic"}')`,
      [id, tenant, source, `https://${o.publisher ?? 'a.example'}/a/${id}`, o.title ?? `Synthetic report ${id.slice(0, 6)}`, o.excerpt ?? null, randomBytes(8).toString('hex'),
        o.publisher ?? 'a.example', new Date(at), o.duplicateOf ? 'duplicate' : 'original', o.duplicateOf ?? null]);
    // Write-time columns (discovered_at, matched_at, finished_at) are set at insertion, exactly as in production.
    if (project) await db.query('INSERT INTO mention_matches (tenant_id, mention_id, project_id, query_id, matched_at) VALUES ($1,$2,$3,$4,clock_timestamp())', [tenant, id, project, query]);
    if (o.label) {
      const a = (await db.query(`INSERT INTO mention_analyses (tenant_id, mention_id, idempotency_key, trigger, status, provider, model, method, pipeline_version, is_current, finished_at)
        VALUES ($1,$2,'fixture','backfill','succeeded','test','test-fixture','test','ai-pipeline/2',true,clock_timestamp()) RETURNING id`, [tenant, id])).rows[0].id;
      if (o.label !== 'unknown') await db.query(`INSERT INTO sentiment_results (tenant_id, mention_id, label, confidence, model_version, target_type, uncertain, method, analysis_id)
        VALUES ($1,$2,$3,0.8,'test-fixture','article',$4,'test',$5)`, [tenant, id, o.label, o.uncertain ?? false, a]);
      for (const e of o.entities ?? []) await db.query(`INSERT INTO mention_entities (tenant_id, mention_id, entity_type, name, confidence, model_version, entity_id, analysis_id)
        VALUES ($1,$2,'government_institution','x',0.9,'test-fixture',$3,$4)`, [tenant, id, e, a]);
      for (const k of o.topics ?? []) await db.query(`INSERT INTO mention_topics (tenant_id, mention_id, topic_key, confidence, model_version, analysis_id, taxonomy_version) VALUES ($1,$2,$3,0.8,'test-fixture',$4,'gov-pa/1')`, [tenant, id, k, a]);
      await db.query('UPDATE mentions SET analysis_id = $2 WHERE id = $1', [id, a]);
    }
    return id;
  }
  const tick = () => reportsSchedulerTick(database, app.get(ReportsEnqueuer), gen, config, clock);

  beforeAll(async () => {
    redis = new IORedis(TEST_REDIS_URL, { maxRetriesPerRequest: null }); await redis.flushdb();
    app = await testApp({ REDIS_URL: TEST_REDIS_URL, AI_PROVIDER: 'test', SMTP_URL: '', EMAIL_FROM: '', REPORT_CONCURRENT_RUNS: '3', REPORT_CSV_ROW_LIMIT: '1000',
      APP_BASE_URL: 'https://app.civicsignal.test' });
    clock = app.get(CLOCK); (clock as { now: () => Date }).now = () => new Date(t);
    gen = app.get(ReportGenerator); database = app.get(Database); config = app.get(CONFIG); provider = app.get(ANALYSIS_PROVIDER);
    db = new Client({ connectionString: OWNER_URL }); await db.connect();
    owner = await registerUser(app, 'Report Owner'); org = await createOrg(app, owner);
    analyst = await addMember(app, owner, org, 'analyst', 'Analyst'); viewer = await addMember(app, owner, org, 'report_viewer', 'Viewer');
    unassigned = await addMember(app, owner, org, 'analyst', 'Unassigned');
    outsider = await registerUser(app, 'Outsider'); otherOrg = await createOrg(app, outsider);
    P = (await api(owner).post('/projects', { name: 'Banjir' }).expect(201)).body.id;
    Q = (await api(owner).post('/projects', { name: 'Lainnya' }).expect(201)).body.id;
    qP = (await api(owner).post(`/projects/${P}/queries`, { name: 'Banjir', keywords: ['banjir'] }).expect(201)).body.id;
    qQ = (await api(owner).post(`/projects/${Q}/queries`, { name: 'Lain', keywords: ['lain'] }).expect(201)).body.id;
    for (const u of [analyst, viewer]) await api(owner).post(`/projects/${P}/members`, { userId: u.id }).expect(204);
    const src = async (name: string, u = owner, o = () => org) => (await api(u, o).post('/sources', { kind: 'feed', name, feedUrl: `https://${name}.example/rss`, authorizationStatus: 'authorized', authorizationBasis: 'Synthetic test fixture' }).expect(201)).body.id;
    s1 = await src('s1'); s2 = await src('s2'); s3 = await src('s3'); otherSource = await src('other', outsider, () => otherOrg);
    await db.query(`UPDATE sources SET permitted_fields = '{title,url,published_at,excerpt}', attribution_requirement = 'Sumber: Publisher A' WHERE id = $1`, [s1]);
    await db.query(`UPDATE sources SET permitted_fields = '{title,url,published_at,excerpt}', redistribution_restrictions = 'Internal use only' WHERE id = $1`, [s2]);
    entA = (await db.query(`INSERT INTO entities (tenant_id, entity_type, display_name, normalized_name) VALUES ($1,'government_institution','Dinas A','dinas a') RETURNING id`, [org])).rows[0].id;
    entB = (await db.query(`INSERT INTO entities (tenant_id, entity_type, display_name, normalized_name) VALUES ($1,'government_institution','Dinas B','dinas b') RETURNING id`, [org])).rows[0].id;
    // Reporting week, project P.
    ids.m1 = await mention(org, s1, P, qP, FROM, { title: '=HYPERLINK("http://evil.example","klik")', publisher: 'a.example', label: 'positive', entities: [entA], excerpt: 'Excerpt one', topics: ['environment'] });
    ids.m2 = await mention(org, s2, P, qP, '2026-10-18T16:59:59.000Z', { publisher: 'b.example', label: 'negative', entities: [entB], excerpt: 'Restricted excerpt', topics: ['environment'] });
    ids.m3 = await mention(org, s1, P, qP, TO, { publisher: 'a.example', label: 'negative' });                         // at `to`: excluded
    ids.m4 = await mention(org, s1, P, qP, '2026-10-13T16:59:00.000Z', { publisher: 'a.example', label: 'neutral', uncertain: true, entities: [entA, entB] });
    ids.m5 = await mention(org, s3, P, qP, '2026-10-13T17:00:00.000Z', { publisher: 'b.example', label: 'unknown' });   // 14 Oct in Jakarta, 13 Oct in UTC
    ids.m6 = await mention(org, s3, P, qP, '2026-10-15T03:00:00.000Z', { publisher: 'c.example' });                     // not analysed
    ids.m7 = await mention(org, s3, P, qP, '2026-10-15T04:00:00.000Z', { publisher: 'c.example', label: 'positive', duplicateOf: ids.m6 });
    ids.m8 = await mention(org, s1, Q, qQ, '2026-10-14T03:00:00.000Z', { label: 'neutral' });                           // other project
    ids.m9 = await mention(org, s1, P, qP, '2026-10-08T03:00:00.000Z', { label: 'neutral' });                           // previous week
    await mention(otherOrg, otherSource, null, null, '2026-10-14T03:00:00.000Z', { label: 'negative' });                // other tenant
  });

  afterAll(async () => {
    await app.get<Queue>(REPORTS_QUEUE).obliterate({ force: true }).catch(() => undefined);
    await app.close(); await db.end(); redis.disconnect();
  });

  describe('metrics', () => {
    it('coverage: half-open period, duplicates, publishers, previous period and local-day buckets', async () => {
      const c = (await api(owner).get(`/analytics/coverage?projectId=${P}&${wk}`).expect(200)).body;
      expect(c.totals).toEqual({ records: 6, articles: 5, duplicates: 1, publishers: 3, sources: 3, storyClusters: 0, unclusteredArticles: 5 });
      expect(c.previousPeriod).toMatchObject({ from: PF, to: FROM, totals: { articles: 1 } });
      expect(c.change.articles).toEqual({ current: 5, previous: 1, delta: 4, pct: 400 });
      expect(c.period).toMatchObject({ from: FROM, to: TO, timezone: 'Asia/Jakarta', granularity: 'day' });
      expect(c.timeline.points).toEqual([
        { bucket: '2026-10-12', articles: 1, records: 1 }, { bucket: '2026-10-13', articles: 1, records: 1 }, { bucket: '2026-10-14', articles: 1, records: 1 },
        { bucket: '2026-10-15', articles: 1, records: 2 }, { bucket: '2026-10-16', articles: 0, records: 0 }, { bucket: '2026-10-17', articles: 0, records: 0 },
        { bucket: '2026-10-18', articles: 1, records: 1 }]);
      expect(c.freshness).toMatchObject({ asOf: new Date(NOW).toISOString() });
      expect(c.definitions.articles).toMatch(/not duplicates/);
    });

    it('sentiment: unknown and unanalysed are counted but excluded from the denominator', async () => {
      const s = (await api(owner).get(`/analytics/sentiment?projectId=${P}&${wk}`).expect(200)).body;
      expect(s.totals.counts).toEqual({ positive: 1, negative: 1, neutral: 1, mixed: 0, unknown: 1, unanalysed: 1, uncertain: 1 });
      expect(s.totals.denominator).toBe(3);
      expect(s.totals.shares).toEqual({ positive: 33.3, negative: 33.3, neutral: 33.3, mixed: 0 });
      expect(s.totals.uncertainShare).toBe(33.3);
      expect(s.totals.net).toBe(0);
      expect(s.limitations.join(' ')).toMatch(/Only 3 articles have a known tone/);
      expect(s.limitations.join(' ')).toMatch(/1 articles are not analysed/);
      const neg = (await api(owner).get(`/analytics/coverage?projectId=${P}&${wk}&sentiment=unanalysed`).expect(200)).body;
      expect(neg.totals.articles).toBe(1);
    });

    it('share of voice: documented denominator, co-mentions and warnings', async () => {
      const v = (await api(owner).get(`/analytics/share-of-voice?projectId=${P}&${wk}&entityIds=${entA},${entB}`).expect(200)).body;
      expect(v.denominator).toBe(4); expect(v.eligibleArticles).toBe(3); expect(v.coMentionArticles).toBe(1);
      expect(v.entities.map((e: { name: string; articles: number; share: number }) => [e.name, e.articles, e.share])).toEqual([['Dinas A', 2, 50], ['Dinas B', 2, 50]]);
      expect(v.autoSelected).toBe(false);
      expect(v.warnings.join(' ')).toMatch(/Only 3 articles mention the selected entities/);
      expect(v.rules.excluded).toMatch(/No reach/);
      await api(owner).get(`/analytics/share-of-voice?projectId=${P}&${wk}&entityIds=${randomUUID()}`).expect(404);
    });

    it('sources, topics and entities', async () => {
      const s = (await api(owner).get(`/analytics/sources?projectId=${P}&${wk}`).expect(200)).body;
      expect(s.totalArticles).toBe(5); expect(s.activePublishers).toBe(3);
      expect(s.publishers.map((p: { domain: string; articles: number; records: number }) => [p.domain, p.articles, p.records])).toEqual([['a.example', 2, 2], ['b.example', 2, 2], ['c.example', 1, 2]]);
      expect(s.diversity.simpson).toBe(0.64);           // 1 − (0.4² + 0.4² + 0.2²)
      expect(s.notes[0]).toMatch(/not a measure of credibility/);
      const tp = (await api(owner).get(`/analytics/topics?projectId=${P}&${wk}`).expect(200)).body;
      expect(tp.topics[0]).toMatchObject({ key: 'environment', articles: 2, current: 2, previous: 0 });
      const en = (await api(owner).get(`/analytics/entities?projectId=${P}&${wk}`).expect(200)).body;
      expect(en.entities.map((e: { name: string; articles: number }) => [e.name, e.articles])).toEqual([['Dinas A', 2], ['Dinas B', 2]]);
      expect(en.coOccurrence).toHaveLength(1);
      expect(en.coOccurrence[0].articles).toBe(1);
    });

    it('buckets follow the tenant time zone', async () => {
      await api(owner).patch('', { settings: { timezone: 'UTC' } }).expect(200);
      const c = (await api(owner).get(`/analytics/coverage?projectId=${P}&from=2026-10-12T00:00:00Z&to=2026-10-15T00:00:00Z`).expect(200)).body;
      expect(c.period.timezone).toBe('UTC');
      expect(c.timeline.points).toEqual([{ bucket: '2026-10-12', articles: 0, records: 0 }, { bucket: '2026-10-13', articles: 2, records: 2 }, { bucket: '2026-10-14', articles: 0, records: 0 }]);
      await api(owner).patch('', { settings: { timezone: 'Asia/Jakarta' } }).expect(200);
    });

    it('rejects invalid and over-long periods', async () => {
      await api(owner).get(`/analytics/coverage?from=${TO}&to=${FROM}`).expect(400);
      await api(owner).get('/analytics/coverage?from=2024-01-01T00:00:00Z&to=2026-01-01T00:00:00Z').expect(400);
      await api(owner).get(`/analytics/coverage?${wk}&sentiment=angry`).expect(400);
    });

    it('caches by data version and invalidates when data changes', async () => {
      const a = (await api(owner).get(`/analytics/coverage?projectId=${P}&${wk}`).expect(200)).body;
      const b = (await api(owner).get(`/analytics/coverage?projectId=${P}&${wk}`).expect(200)).body;
      expect(b.cache.hit).toBe(true); expect(b.totals).toEqual(a.totals);
      ids.m10 = await mention(org, s3, P, qP, '2026-10-16T03:00:00.000Z', { publisher: 'c.example', label: 'neutral' });
      const c = (await api(owner).get(`/analytics/coverage?projectId=${P}&${wk}`).expect(200)).body;
      expect(c.cache.hit).toBe(false); expect(c.totals.articles).toBe(6);
      await db.query('DELETE FROM mentions WHERE id = $1', [ids.m10]);
      // A deletion does not move the watermarks; the explicit version bump (aggregation refresh) invalidates the entry.
      await database.withTenant(org, SYS, (cl) => refreshAnalytics(cl, org, new Date(t), { full: true }));
      const d = (await api(owner).get(`/analytics/coverage?projectId=${P}&${wk}`).expect(200)).body;
      expect(d.cache.hit).toBe(false); expect(d.totals.articles).toBe(5);
    });

    it('the hourly aggregate gives exactly the base-table timeline once current', async () => {
      await database.withTenant(org, SYS, (cl) => refreshAnalytics(cl, org, new Date(t)));
      const agg = (await api(owner).get(`/analytics/coverage?projectId=${P}&${wk}`).expect(200)).body;
      expect(agg.timeline.source).toBe('hourly_aggregate');
      const base = (await api(owner).get(`/analytics/coverage?projectId=${P}&from=${FROM}&to=2026-10-18T17:00:00.001Z`).expect(200)).body;
      expect(base.timeline.source).toBe('base_tables');
      expect(agg.timeline.points).toEqual(base.timeline.points.slice(0, 7));   // base has one extra (partial) bucket for the extra millisecond
      ids.m11 = await mention(org, s3, P, qP, '2026-10-17T03:00:00.000Z', { publisher: 'c.example' });
      const stale = (await api(owner).get(`/analytics/coverage?projectId=${P}&${wk}`).expect(200)).body;
      expect(stale.timeline.source).toBe('base_tables');          // aggregate behind the data → never used
      expect(stale.timeline.points[5]).toEqual({ bucket: '2026-10-17', articles: 1, records: 1 });
      await database.withTenant(org, SYS, (cl) => refreshAnalytics(cl, org, new Date(t)));
      expect((await api(owner).get(`/analytics/coverage?projectId=${P}&${wk}`).expect(200)).body.timeline.source).toBe('hourly_aggregate');
      // Deleting a record does not move any watermark; the aggregate no longer adds up and is not used.
      await db.query('DELETE FROM mentions WHERE id = $1', [ids.m11]);
      await db.query(`UPDATE analytics_state SET data_version = data_version + 1 WHERE tenant_id = $1`, [org]);   // bypass the response cache only
      const afterDelete = (await api(owner).get(`/analytics/coverage?projectId=${P}&${wk}`).expect(200)).body;
      expect(afterDelete.timeline.source).toBe('base_tables');
      expect(afterDelete.timeline.points[5]).toEqual({ bucket: '2026-10-17', articles: 0, records: 0 });
      await database.withTenant(org, SYS, (cl) => refreshAnalytics(cl, org, new Date(t), { full: true }));
    });

    it('respects tenant and project access', async () => {
      const all = (await api(owner).get(`/analytics/coverage?${wk}`).expect(200)).body;
      expect(all.totals.articles).toBe(6);                        // P + Q, never the other tenant's record
      expect((await api(analyst).get(`/analytics/coverage?projectId=${P}&${wk}`).expect(200)).body.totals.articles).toBe(5);
      expect((await api(analyst).get(`/analytics/coverage?${wk}`).expect(200)).body.totals.articles).toBe(5);   // only assigned P
      await api(unassigned).get(`/analytics/coverage?projectId=${P}&${wk}`).expect(404);
      expect((await api(unassigned).get(`/analytics/overview?${wk}`).expect(200)).body.coverage.totals.articles).toBe(0);
      await api(viewer).get(`/analytics/coverage?${wk}`).expect(403);                                     // report viewers: reports only
      expect((await api(outsider).get(`/analytics/coverage?${wk}`)).status).toBeGreaterThanOrEqual(403);
      expect((await api(outsider, () => otherOrg).get(`/analytics/coverage?${wk}`).expect(200)).body.totals.articles).toBe(0);  // unmatched records
    });

    it('overview combines widgets with freshness and completeness', async () => {
      const o = (await api(owner).get(`/analytics/overview?projectId=${P}&${wk}&entityIds=${entA},${entB}`).expect(200)).body;
      expect(o.coverage.totals.articles).toBe(5);
      expect(o.completeness).toMatchObject({ articles: 5, analysed: 4, analysedShare: 80 });
      expect(o.shareOfVoice.denominator).toBe(4);
      expect(o.freshness.sources).toMatchObject({ enabled: 0 });
      expect(o.freshness.notes.join(' ')).toMatch(/No collection source is enabled/);
    });
  });

  describe('reports', () => {
    let def: string; let run: string;

    it('validates definitions and refuses references outside the tenant or project', async () => {
      await api(owner).post('/reports/definitions', { projectId: P, template: 'weekly_intelligence', name: 'Laporan', params: { entityIds: [randomUUID()] } }).expect(400);
      await api(owner).post('/reports/definitions', { projectId: P, template: 'nope', name: 'X' }).expect(400);
      await api(unassigned).post('/reports/definitions', { projectId: P, template: 'weekly_intelligence', name: 'Laporan' }).expect(404);
      await api(viewer).post('/reports/definitions', { projectId: P, template: 'weekly_intelligence', name: 'Laporan' }).expect(403);
      def = (await api(analyst).post('/reports/definitions', { projectId: P, template: 'weekly_intelligence', name: 'Laporan Mingguan Banjir', language: 'en', aiCommentary: true,
        params: { entityIds: [entA, entB] } }).expect(201)).body.id;
    });

    it('generates a validated report: metrics, evidence, AI checks, PDF and CSV', async () => {
      provider.summaryScript = (i) => ({ status: 'ok', headline: null, uncertainty: [], conflicts: [], claims: [
        { text: 'Coverage in this period centred on flooding.', kind: 'interpretation', supportingRefs: [i.records[0]!.ref] },
        { text: 'Coverage rose because of heavy rain.', kind: 'interpretation', supportingRefs: [i.records[0]!.ref] },
        { text: 'Negative coverage reached 87% of articles.', kind: 'interpretation', supportingRefs: [i.records[0]!.ref] },
        { text: 'The public supports the response.', kind: 'interpretation', supportingRefs: [i.records[0]!.ref] },
        { text: 'Unreferenced claim.', kind: 'interpretation', supportingRefs: ['R99'] },
      ] });
      const r = (await api(analyst).post(`/reports/definitions/${def}/generate`, { periodStart: FROM, periodEnd: TO }).set('Idempotency-Key', 'weekly-test-0001').expect(202)).body;
      const again = (await api(analyst).post(`/reports/definitions/${def}/generate`, { periodStart: FROM, periodEnd: TO }).set('Idempotency-Key', 'weekly-test-0001').expect(202)).body;
      expect(again.id).toBe(r.id);
      run = r.id;
      expect(await gen.generate(org, run, true)).toEqual({ status: 'succeeded' });
      const d = (await api(analyst).get(`/reports/runs/${run}`).expect(200)).body;
      expect(d.status).toBe('succeeded');
      expect(d.model.metrics).toMatchObject({ articles: 5, records: 6, publishers: 3, prevArticles: 1, tone_negative: 1, sovEligible: 3 });
      expect(d.model.ai).toMatchObject({ requested: true, method: 'llm', kept: 1 });
      expect(d.model.ai.dropped.map((x: { reason: string }) => x.reason).sort()).toEqual(['causal_claim', 'no_valid_reference', 'public_opinion_claim', 'unsupported_number']);
      const aiParas = d.model.sections.flatMap((s: { blocks: Array<{ type: string; kind?: string; text?: string }> }) => s.blocks).filter((b: { kind?: string }) => b.kind === 'ai_interpretation');
      expect(aiParas.map((b: { text: string }) => b.text)).toEqual(['Coverage in this period centred on flooding.']);
      const cited = (await db.query('SELECT DISTINCT mention_id FROM report_run_sources WHERE run_id = $1', [run])).rows.map((x) => x.mention_id).sort();
      expect(cited.length).toBe(d.citedSources);
      expect(cited.every((id: string) => [ids.m1, ids.m2, ids.m4, ids.m5, ids.m6].includes(id))).toBe(true);
      expect(d.myDeliveries).toEqual([expect.objectContaining({ channel: 'in_app', kind: 'ready', status: 'delivered' })]);
      expect(d.ai.tokensIn).toBeGreaterThan(0);
      expect((await db.query(`SELECT count(*)::int AS n FROM ai_usage_records WHERE tenant_id = $1 AND task = 'report-commentary'`, [org])).rows[0].n).toBe(1);
    });

    it('serves files only to authorised users, with safe headers and an audit trail', async () => {
      const pdf = await api(viewer).get(`/reports/runs/${run}/download/pdf`).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (x: Buffer) => c.push(x)); res.on('end', () => cb(null, Buffer.concat(c))); }).expect(200);
      expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
      expect(pdf.headers['content-disposition']).toBe('attachment; filename="laporan-mingguan-banjir-2026-10-11.pdf"');
      expect(pdf.headers['cache-control']).toBe('private, no-store');
      await api(unassigned).get(`/reports/runs/${run}/download/pdf`).expect(404);
      await api(unassigned).get(`/reports/runs/${run}`).expect(404);
      expect((await api(outsider).get(`/reports/runs/${run}/download/pdf`)).status).toBeGreaterThanOrEqual(403);
      await api(outsider, () => otherOrg).get(`/reports/runs/${run}/download/pdf`).expect(404);         // other tenant's id: invisible under RLS
      await api(viewer).get(`/reports/runs/${run}/download/exe`).expect(404);
      expect((await db.query(`SELECT count(*)::int AS n FROM audit_events WHERE tenant_id = $1 AND action = 'report.downloaded' AND actor_user_id = $2`, [org, viewer.id])).rows[0].n).toBe(1);
    });

    it('exports CSV with stable columns, formula neutralisation and licence-aware excerpts', async () => {
      const res = await api(owner).get(`/reports/runs/${run}/download/csv`).expect(200);
      const text: string = res.text.replace(/^\uFEFF/, '');
      const lines = text.split('\r\n').filter(Boolean);
      expect(lines[0]).toBe(ARTICLE_COLUMNS.map((c) => `"${c}"`).join(','));
      expect(lines).toHaveLength(6);                            // header + 5 unique articles; duplicates and out-of-period records excluded
      expect(text).not.toContain('FULL BODY');
      const row = (id: string): string => lines.find((l) => l.includes(`"${id}"`))!;
      expect(row(ids.m1)).toContain(`"'=HYPERLINK(""http://evil.example"",""klik"")"`);
      expect(row(ids.m1)).toContain('"Excerpt one",""');
      expect(row(ids.m2)).toContain('"","source_redistribution_restricted"');
      expect(row(ids.m2)).not.toContain('Restricted excerpt');
      expect(row(ids.m6)).toContain('"unanalysed"');
      expect(row(ids.m1)).toContain(`"${FROM}","${TO}","Asia/Jakarta","Banjir"`);
    });

    it('retries transient failures and fails visibly when attempts are exhausted', async () => {
      const r = (await api(analyst).post(`/reports/definitions/${def}/generate`, { periodStart: FROM, periodEnd: TO }).expect(202)).body;
      const spy = jest.spyOn(E, 'coverage').mockRejectedValueOnce(new Error('connection reset'));
      await expect(gen.generate(org, r.id, false)).rejects.toThrow('connection reset');
      expect((await db.query('SELECT status, error, attempts FROM report_runs WHERE id = $1', [r.id])).rows[0]).toMatchObject({ status: 'queued', error: 'retrying: connection reset', attempts: 1 });
      expect(await gen.generate(org, r.id, true)).toEqual({ status: 'succeeded' });
      const r2 = (await api(analyst).post(`/reports/definitions/${def}/generate`, { periodStart: FROM, periodEnd: TO }).expect(202)).body;
      spy.mockRejectedValueOnce(new Error('connection reset'));
      expect(await gen.generate(org, r2.id, true)).toEqual({ status: 'failed', error: 'connection reset' });
      spy.mockRestore();
      const f = (await api(analyst).get(`/reports/runs/${r2.id}`).expect(200)).body;
      expect(f).toMatchObject({ status: 'failed', error: 'connection reset' });
      expect(f.myDeliveries).toEqual([expect.objectContaining({ kind: 'failed', channel: 'in_app' })]);
    });

    it('enforces concurrency limits and supports cancellation', async () => {
      const made: string[] = [];
      for (let i = 0; i < 3; i++) made.push((await api(analyst).post(`/reports/definitions/${def}/generate`, { periodStart: FROM, periodEnd: TO }).expect(202)).body.id);
      const r = await api(analyst).post(`/reports/definitions/${def}/generate`, { periodStart: FROM, periodEnd: TO }).expect(429);
      expect(r.body.error.code).toBe('quota_exceeded');
      for (const id of made) await api(analyst).post(`/reports/runs/${id}/cancel`).expect(201);
      expect(await gen.generate(org, made[0]!, true)).toEqual({ status: 'skipped' });
      await api(analyst).post(`/reports/runs/${made[0]}/cancel`).expect(409);
      await api(owner).post(`/reports/definitions/${def}/generate`, { periodStart: FROM, periodEnd: '2027-12-01T00:00:00Z' }).expect(400);
    });

    let sched: string;
    it('validates schedule recipients and creates timezone-aware schedules', async () => {
      const bad = await api(analyst).post('/report-schedules', { definitionId: def, frequency: 'weekly', dayOfWeek: 1, recipientUserIds: [unassigned.id] }).expect(400);
      expect(bad.body.error.code).toBe('invalid_recipients');
      await api(analyst).post('/report-schedules', { definitionId: def, frequency: 'weekly', dayOfWeek: 1, recipientUserIds: [outsider.id] }).expect(400);
      await api(analyst).post('/report-schedules', { definitionId: def, frequency: 'weekly' }).expect(400);
      const s = (await api(analyst).post('/report-schedules', { definitionId: def, frequency: 'weekly', dayOfWeek: 1, timeOfDay: '07:00',
        recipientUserIds: [analyst.id, viewer.id], channels: ['in_app', 'email'] }).expect(201)).body;
      sched = s.id;
      expect(s.timezone).toBe('Asia/Jakarta');
      expect(s.nextRunAt).toBe('2026-10-26T00:00:00.000Z');      // next Monday 07:00 WIB (now is Monday 12:00 WIB)
    });

    it('scheduled runs are idempotent, cover the previous period and deliver only to authorised recipients', async () => {
      t = Date.parse('2026-10-26T00:00:30Z');
      const r1 = await tick();
      expect(r1.created).toBe(1);
      const runs = (await db.query('SELECT id, period_start, period_end, idempotency_key, status FROM report_runs WHERE schedule_id = $1', [sched])).rows;
      expect(runs).toHaveLength(1);
      expect(runs[0].period_start.toISOString()).toBe(TO);       // Mon 19 Oct 00:00 WIB
      expect(runs[0].period_end.toISOString()).toBe('2026-10-25T17:00:00.000Z');
      // A repeated tick, or the same occurrence firing again after a restart, creates nothing new.
      expect((await tick()).created).toBe(0);
      await db.query(`UPDATE report_schedules SET next_run_at = '2026-10-26T00:00:00Z' WHERE id = $1`, [sched]);
      expect((await tick()).created).toBe(0);
      expect((await db.query('SELECT count(*)::int AS n FROM report_runs WHERE schedule_id = $1', [sched])).rows[0].n).toBe(1);
      expect((await db.query('SELECT next_run_at FROM report_schedules WHERE id = $1', [sched])).rows[0].next_run_at.toISOString()).toBe('2026-11-02T00:00:00.000Z');
      // The viewer loses project access before the report is generated: nothing is delivered to them.
      await db.query('DELETE FROM project_members WHERE project_id = $1 AND user_id = $2', [P, viewer.id]);
      expect(await gen.generate(org, runs[0].id, true)).toEqual({ status: 'succeeded' });
      const dl = (await db.query('SELECT user_id, channel, status, error FROM report_deliveries WHERE run_id = $1 ORDER BY user_id, channel', [runs[0].id])).rows;
      const of = (u: string, ch: string) => dl.find((x) => x.user_id === u && x.channel === ch);
      expect(of(analyst.id, 'in_app').status).toBe('delivered');
      expect(of(analyst.id, 'email')).toMatchObject({ status: 'unconfigured' });      // no SMTP in this test: recorded, never reported as sent
      expect(of(viewer.id, 'in_app')).toMatchObject({ status: 'suppressed', error: 'Recipient is no longer authorised for this project' });
      await api(owner).post(`/projects/${P}/members`, { userId: viewer.id }).expect(204);
    });

    it('edits and cancels schedules', async () => {
      const u = (await api(analyst).patch(`/report-schedules/${sched}`, { timeOfDay: '08:30', timezone: 'Asia/Makassar' }).expect(200)).body;
      // 08:30 WITA = 00:30 UTC, still ahead today; that occurrence reports the same (already generated) week, so its
      // idempotency key would create nothing new.
      expect(u.nextRunAt).toBe('2026-10-26T00:30:00.000Z');
      await api(analyst).post(`/report-schedules/${sched}/cancel`).expect(201);
      await api(analyst).patch(`/report-schedules/${sched}`, { isActive: true }).expect(409);
      t = Date.parse('2026-11-02T01:00:00Z');
      expect((await tick()).created).toBe(0);
    });

    it('fails abandoned runs and expires artifacts under the retention policy', async () => {
      const stuck = (await api(analyst).post(`/reports/definitions/${def}/generate`, { periodStart: FROM, periodEnd: TO }).expect(202)).body.id;
      await db.query(`UPDATE report_runs SET status = 'running', started_at = $2, heartbeat_at = $2 WHERE id = $1`, [stuck, new Date(t - 60 * 60_000)]);
      t += 31 * 86_400_000;
      const r = await tick();
      expect(r.abandoned).toBeGreaterThanOrEqual(1);
      expect((await db.query('SELECT status, error FROM report_runs WHERE id = $1', [stuck])).rows[0]).toMatchObject({ status: 'failed', error: expect.stringMatching(/^Abandoned/) });
      expect(r.expired).toBeGreaterThanOrEqual(2);
      const res = await api(owner).get(`/reports/runs/${run}/download/pdf`).expect(410);
      expect(res.body.error.code).toBe('artifact_expired');
      const meta = (await api(owner).get(`/reports/runs/${run}`).expect(200)).body.artifacts;
      expect(meta.every((a: { expired: boolean; sha256: string }) => a.expired && a.sha256.length === 64)).toBe(true);
    });

    it('lists only reports in visible projects and never across tenants', async () => {
      expect((await api(analyst).get('/reports/runs').expect(200)).body.page.total).toBeGreaterThan(0);
      expect((await api(unassigned).get('/reports/runs').expect(200)).body.page.total).toBe(0);
      expect((await api(unassigned).get('/reports/definitions').expect(200)).body.definitions).toHaveLength(0);
      expect((await api(outsider, () => otherOrg).get('/reports/runs').expect(200)).body.page.total).toBe(0);
      expect((await api(viewer).get('/reports/inbox').expect(200)).body.deliveries.length).toBeGreaterThanOrEqual(0);
      await api(viewer).post(`/reports/definitions/${def}/generate`, {}).expect(403);
    });
  });
});
