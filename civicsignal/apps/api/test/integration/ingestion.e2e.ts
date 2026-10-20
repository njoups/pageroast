import { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import request from 'supertest';
import { ConnectorError } from '../../src/ingestion/connectors/connector';
import { IngestionPipeline } from '../../src/ingestion/pipeline.service';
import { OWNER_URL } from '../env';
import { addMember, createOrg, registerUser, testApp, TestUser } from '../helpers';
import { FeedServer, rss } from './feed-server';

/** Real API + pipeline + PostgreSQL against a local synthetic feed server. Queue is exercised in queue.e2e.ts. */
describe('ingestion pipeline (e2e)', () => {
  let app: INestApplication; let srv: FeedServer; let pipeline: IngestionPipeline;
  const http = () => request(app.getHttpServer());
  let owner: TestUser; let org: string; let projectId: string;
  let version = 1;
  const items1 = [
    { title: 'Banjir rendam tiga kecamatan di Kota Contoh', link: 'https://news.example/a/banjir?utm_source=rss', description: 'Hujan deras sejak malam.', pubDate: 'Mon, 19 Oct 2026 08:00:00 +0700', content: 'FULL BODY TEXT' },
    { title: 'Harga cabai naik menjelang akhir tahun', link: 'https://news.example/a/cabai', description: 'Pasar tradisional.' },
    { title: 'Item without link' },
  ];
  const run = (sourceId: string, key: string, attempt = 1, final = false) =>
    pipeline.run({ tenantId: org, sourceId, trigger: 'manual', idempotencyKey: key, requestedBy: owner.id }, attempt, final);

  beforeAll(async () => {
    srv = await new FeedServer().start();
    srv.xml('/feed.xml', () => rss(version === 1 ? items1 : [
      ...items1,
      // same publisher, same headline, different URL → duplicate
      { title: 'Banjir rendam tiga kecamatan di Kota Contoh', link: 'https://news.example/a/banjir-v2', description: 'Hujan deras sejak malam.' },
      // already known URL with only tracking params changed → known
      { title: 'Harga cabai naik menjelang akhir tahun', link: 'https://news.example/a/cabai?fbclid=zzz' },
      // different publisher, identical headline → separate original (provenance preserved)
      { title: 'Banjir rendam tiga kecamatan di Kota Contoh', link: 'https://other.example/banjir' },
    ]), () => `"v${version}"`);
    srv.route('/500', (_q, r) => { r.statusCode = 503; r.setHeader('retry-after', '1'); r.end(); });
    srv.route('/gone', (_q, r) => { r.statusCode = 410; r.end(); });
    srv.route('/html', (_q, r) => { r.setHeader('content-type', 'text/html'); r.end('<!DOCTYPE html><html><body>Sign in</body></html>'); });
    app = await testApp({ INGESTION_ALLOW_PRIVATE_HOSTS: 'true', INGESTION_HTTP_TIMEOUT_MS: '5000' });
    pipeline = app.get(IngestionPipeline);
    owner = await registerUser(app, 'Ingest Owner');
    org = await createOrg(app, owner);
    projectId = (await http().post(`/api/v1/organizations/${org}/projects`).set('Cookie', owner.cookie).send({ name: 'Bencana' }).expect(201)).body.id;
    await http().post(`/api/v1/organizations/${org}/projects/${projectId}/queries`).set('Cookie', owner.cookie)
      .send({ name: 'Banjir', keywords: ['banjir'], booleanExpression: '"kota contoh" OR jakarta', exclusions: ['hoaks'] }).expect(201);
  });
  afterAll(async () => { await app.close(); await srv.close(); });

  const createSource = (body: Record<string, unknown>, who = owner) => http().post(`/api/v1/organizations/${org}/sources`).set('Cookie', who.cookie).send(body);
  const authorizedFeed = (path: string, extra: Record<string, unknown> = {}) => ({
    kind: 'feed', name: `Synthetic ${path}`, feedUrl: srv.url(path), authorizationStatus: 'authorized',
    authorizationBasis: 'Synthetic test feed (local test server)', permittedFields: ['title', 'url', 'published_at', 'excerpt'], ...extra,
  });

  describe('registry rules', () => {
    it('creates disabled sources with honest unknown health', async () => {
      const r = await createSource(authorizedFeed('/feed.xml', { name: 'Registry check' , feedUrl: srv.url('/feed.xml?x=1') })).expect(201);
      expect(r.body).toMatchObject({ enabled: false, health: 'disabled', verificationStatus: 'unverified', lastSuccessAt: null, recordsCollected: 0 });
      await http().post(`/api/v1/organizations/${org}/sources/${r.body.id}/enable`).set('Cookie', owner.cookie).expect(200)
        .expect((x) => expect(x.body).toMatchObject({ enabled: true, health: 'unknown', schedule: { active: true } }));
    });
    it('requires an authorization basis, and authorization before enabling', async () => {
      await createSource({ ...authorizedFeed('/feed.xml'), authorizationBasis: '' }).expect(400);
      const s = (await createSource({ kind: 'feed', name: 'Unverified', feedUrl: srv.url('/unverified.xml') }).expect(201)).body;
      const r = await http().post(`/api/v1/organizations/${org}/sources/${s.id}/enable`).set('Cookie', owner.cookie).expect(409);
      expect(r.body.error.code).toBe('source_not_authorized');
    });
    it('revoking authorization stops collection', async () => {
      const s = (await createSource(authorizedFeed('/revoke.xml')).expect(201)).body;
      await http().post(`/api/v1/organizations/${org}/sources/${s.id}/enable`).set('Cookie', owner.cookie).expect(200);
      const r = await http().patch(`/api/v1/organizations/${org}/sources/${s.id}`).set('Cookie', owner.cookie).send({ authorizationStatus: 'revoked' }).expect(200);
      expect(r.body).toMatchObject({ enabled: false, schedule: { active: false } });
    });
    it('validates GDELT configuration and rejects unknown kinds', async () => {
      await createSource({ kind: 'gdelt', name: 'GDELT bad' }).expect(400);
      const g = await createSource({ kind: 'gdelt', name: 'GDELT ok', connectorConfig: { query: 'banjir sourcecountry:indonesia' } }).expect(201);
      expect(g.body).toMatchObject({ domain: 'gdeltproject.org', feedUrl: null, connector: { kind: 'gdelt', config: { query: 'banjir sourcecountry:indonesia', timespan: '1h', maxRecords: 75 } } });
      await createSource({ kind: 'scraper', name: 'Nope', feedUrl: srv.url('/x') }).expect(400);
    });
    it('credentials: not accepted for connectors that do not use them, never returned', async () => {
      const s = (await createSource(authorizedFeed('/cred.xml')).expect(201)).body;
      await http().put(`/api/v1/organizations/${org}/sources/${s.id}/credentials`).set('Cookie', owner.cookie).send({ secret: 'super-secret-key' }).expect(400);
      const r = await http().get(`/api/v1/organizations/${org}/sources/${s.id}`).set('Cookie', owner.cookie).expect(200);
      expect(JSON.stringify(r.body)).not.toMatch(/ciphertext|super-secret/);
      expect(r.body.connector.credentials).toEqual({ configured: false, hint: null, updatedAt: null });
    });
    it('collect-now reports 503 honestly when no queue is configured', async () => {
      const s = (await createSource(authorizedFeed('/noqueue.xml')).expect(201)).body;
      const r = await http().post(`/api/v1/organizations/${org}/sources/${s.id}/collect`).set('Cookie', owner.cookie).expect(503);
      expect(r.body.error.code).toBe('queue_unavailable');
    });
  });

  describe('collection', () => {
    let sourceId: string;
    beforeAll(async () => { sourceId = (await createSource(authorizedFeed('/feed.xml')).expect(201)).body.id; });

    it('fetches, normalises, persists with attribution, and matches queries', async () => {
      const out = await run(sourceId, 'k1');
      expect(out).toMatchObject({ status: 'succeeded', counts: { seen: 2, new: 2, known: 0, duplicate: 0, rejected: 1, matches: 1 } });
      const list = await http().get(`/api/v1/organizations/${org}/mentions?sort=discovered`).set('Cookie', owner.cookie).expect(200);
      expect(list.body.total).toBe(2);
      const banjir = list.body.items.find((m: { title: string }) => m.title.startsWith('Banjir'));
      expect(banjir).toMatchObject({
        canonical_url: 'https://news.example/a/banjir', url: 'https://news.example/a/banjir?utm_source=rss', publisher: 'Synthetic Daily',
        publisher_domain: 'news.example', excerpt: 'Hujan deras sejak malam.', language: 'id', source_type: 'rss', duplicate_status: 'original',
        processing_status: 'pending', dataOrigin: 'live', attribution: null,
      });
      expect(new Date(banjir.published_at).toISOString()).toBe('2026-10-19T01:00:00.000Z');
      expect(banjir.discovered_at).toBeTruthy();
      expect(banjir.matches).toEqual([expect.objectContaining({ projectId, queryName: 'Banjir', terms: ['banjir', '"kota contoh"'] })]);
      const detail = await http().get(`/api/v1/organizations/${org}/mentions/${banjir.id}`).set('Cookie', owner.cookie).expect(200);
      expect(detail.body.body).toBeNull();                        // licence does not permit full text
      expect(detail.body.provenance).toMatchObject({ connector: 'feed', sourceId, licence: { permitsFullText: false } });
    });

    it('records the run, verifies the source and marks it healthy only after a real success', async () => {
      const s = (await http().get(`/api/v1/organizations/${org}/sources/${sourceId}`).set('Cookie', owner.cookie).expect(200)).body;
      expect(s).toMatchObject({ verificationStatus: 'verified', recordsCollected: 2, consecutiveFailures: 0, lastError: null });
      expect(s.lastSuccessAt).toBeTruthy();
      const runs = (await http().get(`/api/v1/organizations/${org}/sources/${sourceId}/runs`).set('Cookie', owner.cookie).expect(200)).body;
      expect(runs[0]).toMatchObject({ status: 'succeeded', records_seen: 2, records_new: 2, records_rejected: 1, matches: 1, http_status: 200, not_modified: false });
      expect(runs[0].stages).toMatchObject({ fetch: 'ok', persist: 'ok', queue_analysis: 'queue_unavailable', alerts: 'after_analysis' });
    });

    it('is idempotent per job key', async () => {
      expect(await run(sourceId, 'k1')).toEqual({ status: 'already_succeeded', runId: null });
    });

    it('uses conditional requests: unchanged feed returns 304 and stores nothing', async () => {
      const out = await run(sourceId, 'k2');
      expect(out).toMatchObject({ status: 'succeeded', notModified: true, counts: { new: 0 } });
      expect(srv.hits.filter((h) => h.path === '/feed.xml').at(-1)!.headers['if-none-match']).toBe('"v1"');
    });

    it('deduplicates by canonical URL and same-publisher headline, keeps other publishers separate', async () => {
      version = 2;
      const out = await run(sourceId, 'k3');
      expect(out).toMatchObject({ counts: { seen: 5, new: 2, known: 3, duplicate: 1 } });
      const all = (await http().get(`/api/v1/organizations/${org}/mentions?includeDuplicates=true`).set('Cookie', owner.cookie).expect(200)).body.items;
      const dup = all.find((m: { canonical_url: string }) => m.canonical_url === 'https://news.example/a/banjir-v2');
      const orig = all.find((m: { canonical_url: string }) => m.canonical_url === 'https://news.example/a/banjir');
      const other = all.find((m: { canonical_url: string }) => m.canonical_url === 'https://other.example/banjir');
      expect(dup).toMatchObject({ duplicate_status: 'duplicate', duplicate_of: orig.id, duplicate_reason: 'content_hash' });
      expect(other).toMatchObject({ duplicate_status: 'original', publisher_domain: 'other.example' });
      expect(other.matches).toHaveLength(1);              // originals are matched; the duplicate is not double-counted
      expect(dup.matches).toHaveLength(0);
      const visible = (await http().get(`/api/v1/organizations/${org}/mentions`).set('Cookie', owner.cookie).expect(200)).body;
      expect(visible.total).toBe(3);                      // duplicates hidden by default
    });

    it('full text is stored only when the source licence permits it', async () => {
      const s = (await createSource(authorizedFeed('/feed.xml', { name: 'Full text licence', feedUrl: srv.url('/feed.xml?licensed=1'), permitsFullText: true })).expect(201)).body;
      // Same articles are already stored from the first source, so use a fresh tenant view: check provenance of a new item instead.
      srv.xml('/fulltext.xml', () => rss([{ title: 'Laporan lengkap anggaran daerah', link: 'https://news.example/a/anggaran', content: 'FULL BODY TEXT' }]));
      await http().patch(`/api/v1/organizations/${org}/sources/${s.id}`).set('Cookie', owner.cookie).send({ feedUrl: srv.url('/fulltext.xml') }).expect(200);
      await run(s.id, 'ft1');
      const m = (await http().get(`/api/v1/organizations/${org}/mentions?q=anggaran`).set('Cookie', owner.cookie).expect(200)).body.items[0];
      const d = (await http().get(`/api/v1/organizations/${org}/mentions/${m.id}`).set('Cookie', owner.cookie).expect(200)).body;
      expect(d.body).toBe('FULL BODY TEXT');
    });

    it('full-text search and filters work', async () => {
      const q = (s: string) => http().get(`/api/v1/organizations/${org}/mentions?${s}`).set('Cookie', owner.cookie).expect(200).then((r) => r.body);
      expect((await q('q=cabai')).total).toBe(1);
      expect((await q(`q=${encodeURIComponent('banjir -cabai')}&sort=relevance`)).total).toBe(2);
      expect((await q(`projectId=${projectId}`)).total).toBe(2);
      expect((await q(`sourceId=${sourceId}&language=id`)).total).toBe(3);
      expect((await q('dateField=published&from=2026-10-19T00:00:00Z&to=2026-10-19T02:00:00Z')).total).toBe(1);
      await http().get(`/api/v1/organizations/${org}/mentions?limit=1000`).set('Cookie', owner.cookie).expect(400);
    });

    it('query changes re-match existing records', async () => {
      const q = await http().post(`/api/v1/organizations/${org}/projects/${projectId}/queries`).set('Cookie', owner.cookie)
        .send({ name: 'Harga pangan', keywords: ['cabai', 'beras'] }).expect(201);
      expect(q.body).toMatchObject({ rematched: 1, match_count: 1 });
      const bad = await http().post(`/api/v1/organizations/${org}/projects/${projectId}/queries`).set('Cookie', owner.cookie)
        .send({ name: 'Broken', booleanExpression: 'banjir AND (jakarta' }).expect(400);
      expect(bad.body.error).toMatchObject({ code: 'invalid_query', details: { position: 19 } });
      const v = await http().post(`/api/v1/organizations/${org}/queries/validate`).set('Cookie', owner.cookie).send({ booleanExpression: 'OR x' }).expect(200);
      expect(v.body).toMatchObject({ valid: false, position: 0 });
    });
  });

  describe('failures and health', () => {
    it('transient failures retry, then dead-letter; health degrades then fails; a failing source does not affect others', async () => {
      const s = (await createSource(authorizedFeed('/500')).expect(201)).body;
      await http().post(`/api/v1/organizations/${org}/sources/${s.id}/enable`).set('Cookie', owner.cookie).expect(200);
      await expect(run(s.id, 'f1', 1, false)).rejects.toMatchObject({ kind: 'server', retryable: true });
      let src = (await http().get(`/api/v1/organizations/${org}/sources/${s.id}`).set('Cookie', owner.cookie)).body;
      expect(src).toMatchObject({ health: 'degraded', consecutiveFailures: 1, lastError: { kind: 'server', httpStatus: 503 } });
      await expect(run(s.id, 'f1', 2, false)).rejects.toBeInstanceOf(ConnectorError);
      await expect(run(s.id, 'f1', 3, true)).rejects.toBeInstanceOf(ConnectorError);
      src = (await http().get(`/api/v1/organizations/${org}/sources/${s.id}`).set('Cookie', owner.cookie)).body;
      expect(src).toMatchObject({ health: 'failing', consecutiveFailures: 3 });
      const runs = (await http().get(`/api/v1/organizations/${org}/sources/${s.id}/runs`).set('Cookie', owner.cookie)).body;
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ status: 'dead_lettered', attempt: 3, http_status: 503 });
    });

    it.each([['/gone', 'not_found'], ['/html', 'malformed']])('%s fails permanently (%s) without retrying', async (path, kind) => {
      const s = (await createSource(authorizedFeed(path)).expect(201)).body;
      await expect(run(s.id, `p-${kind}`, 1, false)).rejects.toMatchObject({ kind, retryable: false });
      const runs = (await http().get(`/api/v1/organizations/${org}/sources/${s.id}/runs`).set('Cookie', owner.cookie)).body;
      expect(runs[0].status).toBe('failed');
    });

    it('unauthorized sources never run, even if a job is queued', async () => {
      const s = (await createSource({ kind: 'feed', name: 'Not authorized', feedUrl: srv.url('/feed.xml?unauth=1') }).expect(201)).body;
      const before = srv.hitsFor('/feed.xml');
      await expect(run(s.id, 'u1')).rejects.toMatchObject({ kind: 'unconfigured' });
      expect(srv.hitsFor('/feed.xml')).toBe(before);
    });

    it('metrics are derived from runs', async () => {
      const m = (await http().get(`/api/v1/organizations/${org}/ingestion/metrics?hours=24`).set('Cookie', owner.cookie).expect(200)).body;
      expect(m.runs).toMatchObject({ dead_lettered: 1, rate_limited_responses: 0, not_modified: 1 });
      expect(m.runs.attempts).toBeGreaterThanOrEqual(6);
      expect(m.runs.discovered).toBeGreaterThanOrEqual(8);
      expect(m.worker).toEqual({ online: false, instances: 0 });
      expect(m.queueConfigured).toBe(false);
    });
  });

  describe('authorization and tenant isolation', () => {
    it('role permissions on sources and mentions', async () => {
      const analyst = await addMember(app, owner, org, 'analyst', 'Ana Analyst');
      const viewer = await addMember(app, owner, org, 'report_viewer', 'Vic Viewer');
      await createSource(authorizedFeed('/analyst.xml'), analyst).expect(403);
      await http().get(`/api/v1/organizations/${org}/sources`).set('Cookie', analyst.cookie).expect(200);
      await http().get(`/api/v1/organizations/${org}/sources`).set('Cookie', viewer.cookie).expect(403);
      await http().get(`/api/v1/organizations/${org}/mentions`).set('Cookie', viewer.cookie).expect(403);
      // analysts see only mentions matched to projects they are assigned to
      expect((await http().get(`/api/v1/organizations/${org}/mentions`).set('Cookie', analyst.cookie).expect(200)).body.total).toBe(0);
      await http().post(`/api/v1/organizations/${org}/projects/${projectId}/members`).set('Cookie', owner.cookie).send({ userId: analyst.id }).expect(204);
      const seen = (await http().get(`/api/v1/organizations/${org}/mentions`).set('Cookie', analyst.cookie).expect(200)).body;
      expect(seen.total).toBe(3);
      const unmatched = (await http().get(`/api/v1/organizations/${org}/mentions?q=anggaran`).set('Cookie', owner.cookie)).body.items[0];
      await http().get(`/api/v1/organizations/${org}/mentions/${unmatched.id}`).set('Cookie', analyst.cookie).expect(404);
      // Paging (ids paged first, rows built per page) returns the same order and total as one unpaged request, per role.
      for (const u of [owner, analyst]) {
        const full = (await http().get(`/api/v1/organizations/${org}/mentions?limit=100`).set('Cookie', u.cookie).expect(200)).body;
        const paged: string[] = [];
        for (let off = 0; off < full.total; off += 2) {
          const pg = (await http().get(`/api/v1/organizations/${org}/mentions?limit=2&offset=${off}`).set('Cookie', u.cookie).expect(200)).body;
          expect(pg.total).toBe(full.total);
          paged.push(...pg.items.map((m: { id: string }) => m.id));
        }
        expect(paged).toEqual(full.items.map((m: { id: string }) => m.id));
        expect((await http().get(`/api/v1/organizations/${org}/mentions?limit=2&offset=${full.total}`).set('Cookie', u.cookie).expect(200)).body).toMatchObject({ items: [], total: 0 });
      }
    });

    it('another tenant cannot see or touch this tenant\'s sources, runs or mentions', async () => {
      const intruder = await registerUser(app, 'Intruder');
      const other = await createOrg(app, intruder);
      const srcs = (await http().get(`/api/v1/organizations/${org}/sources`).set('Cookie', owner.cookie)).body;
      const ment = (await http().get(`/api/v1/organizations/${org}/mentions`).set('Cookie', owner.cookie)).body.items;
      await http().get(`/api/v1/organizations/${org}/sources`).set('Cookie', intruder.cookie).expect(404);
      await http().get(`/api/v1/organizations/${other}/sources/${srcs[0].id}`).set('Cookie', intruder.cookie).expect(404);
      await http().get(`/api/v1/organizations/${other}/sources/${srcs[0].id}/runs`).set('Cookie', intruder.cookie).expect(404);
      await http().post(`/api/v1/organizations/${other}/sources/${srcs[0].id}/enable`).set('Cookie', intruder.cookie).expect(404);
      await http().get(`/api/v1/organizations/${other}/mentions/${ment[0].id}`).set('Cookie', intruder.cookie).expect(404);
      expect((await http().get(`/api/v1/organizations/${other}/mentions`).set('Cookie', intruder.cookie)).body.total).toBe(0);
      // A worker job naming the wrong tenant finds nothing (RLS), so it cannot read or write across tenants.
      await expect(pipeline.run({ tenantId: other, sourceId: srcs[0].id, trigger: 'manual', idempotencyKey: 'x-tenant' }, 1, true)).rejects.toMatchObject({ kind: 'not_found' });
    });

    it('database rejects cross-tenant match rows even for the owner role', async () => {
      const c = new Client({ connectionString: OWNER_URL }); await c.connect();
      const other = (await c.query(`SELECT id FROM tenants WHERE id <> $1 LIMIT 1`, [org])).rows[0].id;
      // A mention/query pair with no existing match, so only the tenant mismatch can fail the insert.
      const pair = (await c.query(
        `SELECT m.id AS mention_id, q.id AS query_id, q.project_id FROM mentions m CROSS JOIN monitoring_queries q
         WHERE m.tenant_id = $1 AND q.tenant_id = $1 AND NOT EXISTS (SELECT 1 FROM mention_matches x WHERE x.mention_id = m.id AND x.query_id = q.id) LIMIT 1`, [org])).rows[0];
      await expect(c.query(`INSERT INTO mention_matches (tenant_id, mention_id, project_id, query_id) VALUES ($1,$2,$3,$4)`, [other, pair.mention_id, pair.project_id, pair.query_id])).rejects.toThrow(/foreign key/);
      await c.end();
    });

    it('sources with collected records cannot be deleted (provenance), empty ones can', async () => {
      const srcs = (await http().get(`/api/v1/organizations/${org}/sources`).set('Cookie', owner.cookie)).body as Array<{ id: string; recordsCollected: number }>;
      const withData = srcs.find((s) => s.recordsCollected > 0)!;
      const empty = srcs.find((s) => s.recordsCollected === 0)!;
      expect((await http().delete(`/api/v1/organizations/${org}/sources/${withData.id}`).set('Cookie', owner.cookie).expect(409)).body.error.code).toBe('source_has_mentions');
      await http().delete(`/api/v1/organizations/${org}/sources/${empty.id}`).set('Cookie', owner.cookie).expect(204);
    });
  });
});
