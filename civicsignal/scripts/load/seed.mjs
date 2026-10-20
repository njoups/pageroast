#!/usr/bin/env node
// Seeds a DEDICATED load-test database with synthetic tenants and mentions. Never point it at a real environment.
//   API_URL=http://localhost:4100 LOAD_ADMIN_URL=postgres://<superuser>@host/civicsignal_load FEED_BASE=http://127.0.0.1:4199 \
//   TENANTS=3 MENTIONS_PER_TENANT=20000 OUT=/path/seed.json node scripts/load/seed.mjs
// Tenants, users, projects, queries and sources are created through the API (the real code paths); the mention corpus
// is bulk-inserted with SQL in the shape the ingestion pipeline writes (mentions, project matches, current analysis,
// sentiment, topics), because collecting 10^5 articles from feeds would take hours. All content is synthetic.
// The generated passwords are random, stored only in OUT (mode 0600) and valid only in the load database.
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const { Client } = require('pg');

const API = process.env.API_URL ?? 'http://localhost:4100';
const ORIGIN = process.env.APP_ORIGIN ?? 'http://localhost:3000';
const ADMIN = process.env.LOAD_ADMIN_URL;
const FEED_BASE = process.env.FEED_BASE ?? 'http://127.0.0.1:4199';
const TENANTS = Number(process.env.TENANTS ?? 3);
const PER_TENANT = Number(process.env.MENTIONS_PER_TENANT ?? 20000);
const OUT = process.env.OUT ?? 'load-seed.json';
if (!ADMIN) throw new Error('LOAD_ADMIN_URL is required (superuser connection to the dedicated load database)');
if (!/load|perf|bench/i.test(new URL(ADMIN).pathname)) throw new Error('refusing: the database name must contain "load", "perf" or "bench"');

async function call(method, path, body, cookie) {
  const res = await fetch(`${API}/api/v1${path}`, {
    method, headers: { 'content-type': 'application/json', origin: ORIGIN, ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
  return { body: text ? JSON.parse(text) : null, cookie: res.headers.getSetCookie?.()[0]?.split(';')[0] };
}

const db = new Client({ connectionString: ADMIN });
await db.connect();
const tenants = [];
for (let i = 0; i < TENANTS; i++) {
  const email = `load-${i}-${randomBytes(3).toString('hex')}@load.civicsignal.test`;
  const password = randomBytes(18).toString('base64url');
  const reg = await call('POST', '/auth/register', { email, password, displayName: `Load Tenant ${i}` });
  const cookie = reg.cookie;
  const org = (await call('POST', '/organizations', { name: `Load Org ${i}` }, cookie)).body.id;
  const project = (await call('POST', `/organizations/${org}/projects`, { name: 'Pemantauan Banjir' }, cookie)).body.id;
  const query = (await call('POST', `/organizations/${org}/projects/${project}/queries`, { name: 'Banjir', keywords: ['banjir'] }, cookie)).body.id;
  const sources = [];
  for (let s = 0; s < 2; s++) {
    const src = (await call('POST', `/organizations/${org}/sources`, {
      kind: 'feed', name: `Synthetic feed ${i}-${s}`, feedUrl: `${FEED_BASE}/feed/${i}-${s}.xml`, authorizationStatus: 'authorized',
      authorizationBasis: 'Synthetic load-test feed served locally', permittedFields: ['title', 'url', 'published_at', 'excerpt'],
    }, cookie)).body;
    sources.push(src.id);
  }
  const def = (await call('POST', `/organizations/${org}/reports/definitions`, { projectId: project, template: 'weekly_intelligence', name: 'Laporan Mingguan' }, cookie)).body.id;

  // Bulk corpus: 90 days of mentions; ~60% match the project query; ~70% carry a current analysis with sentiment and a topic.
  const t0 = Date.now();
  await db.query('BEGIN');
  await db.query('SET LOCAL row_security = off');
  await db.query(`
    INSERT INTO mentions (tenant_id, source_id, url, canonical_url, title, excerpt, content_hash, publisher_domain, publisher, published_at, discovered_at,
                          detected_language, duplicate_status, provenance)
    SELECT $1::uuid, ($2::uuid[])[1 + g % 2], u, u,
           (ARRAY['Banjir','Harga beras','Anggaran daerah','Pelayanan publik','Jalan rusak','Vaksinasi'])[1 + g % 6] || ' ' || (ARRAY['Jakarta','Bandung','Surabaya','Medan','Makassar'])[1 + g % 5] || ' #' || g,
           'Ringkasan sintetis untuk uji beban nomor ' || g || CASE WHEN g % 5 < 3 THEN ' banjir melanda wilayah' ELSE ' kegiatan pemerintah' END,
           md5('load' || $1::text || g), 'pub' || (g % 30) || '.load.test', 'Publisher ' || (g % 30), ts, ts + interval '5 minutes', 'id', 'original',
           '{"fixture":"load-test synthetic"}'
    FROM generate_series(1, $3::int) g,
         LATERAL (SELECT 'https://pub' || (g % 30) || '.load.test/a/' || $1 || '/' || g AS u, now() - (g % 129600) * interval '1 minute' AS ts) x`,
  [org, sources, PER_TENANT]);
  await db.query(`INSERT INTO mention_matches (tenant_id, mention_id, project_id, query_id, matched_at)
    SELECT tenant_id, id, $2, $3, discovered_at FROM mentions WHERE tenant_id = $1 AND excerpt LIKE '%banjir%'`, [org, project, query]);
  await db.query(`WITH a AS (
      INSERT INTO mention_analyses (tenant_id, mention_id, idempotency_key, trigger, status, provider, model, method, pipeline_version, is_current, finished_at)
      SELECT tenant_id, id, 'load', 'backfill', 'succeeded', 'baseline', 'load-fixture', 'baseline', 'ai-pipeline/2', true, discovered_at
      FROM mentions WHERE tenant_id = $1::uuid AND (hashtext(id::text) & 1023) < 717 RETURNING id, mention_id),
    s AS (INSERT INTO sentiment_results (tenant_id, mention_id, label, confidence, model_version, target_type, uncertain, method, analysis_id)
      SELECT $1::uuid, mention_id, (ARRAY['positive','neutral','negative'])[1 + (hashtext(mention_id::text) & 3) % 3], 0.8, 'load-fixture', 'article', false, 'baseline', id FROM a RETURNING 1),
    tp AS (INSERT INTO mention_topics (tenant_id, mention_id, topic_key, confidence, model_version, analysis_id, taxonomy_version)
      SELECT $1::uuid, mention_id, (ARRAY['environment','economy','public_services','infrastructure','health'])[1 + (hashtext(mention_id::text) & 7) % 5], 0.8, 'load-fixture', id, 'gov-pa/1' FROM a RETURNING 1)
    UPDATE mentions m SET analysis_id = a.id, analyzed_at = now(), processing_status = 'analyzed' FROM a WHERE m.id = a.mention_id`, [org]);
  await db.query('COMMIT');
  const n = (await db.query('SELECT (SELECT count(*) FROM mentions WHERE tenant_id = $1) AS m, (SELECT count(*) FROM mention_matches WHERE tenant_id = $1) AS mm', [org])).rows[0];
  console.log(`tenant ${i}: org ${org.slice(0, 8)}… ${n.m} mentions, ${n.mm} matched, corpus inserted in ${Date.now() - t0} ms`);
  tenants.push({ email, password, org, project, query, sources, reportDefinition: def });
}
await db.query('ANALYZE');
await db.end();
writeFileSync(OUT, JSON.stringify({ api: API, origin: ORIGIN, feedBase: FEED_BASE, perTenant: PER_TENANT, tenants }, null, 2), { mode: 0o600 });
console.log(`seed written to ${OUT} (contains synthetic credentials; mode 0600)`);
