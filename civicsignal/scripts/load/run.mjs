#!/usr/bin/env node
// Reproducible load scenarios against a running API + worker seeded by scripts/load/seed.mjs. No external services are contacted:
// the ingestion scenario serves its synthetic feeds from a local HTTP server (FEED_BASE).
//   SEED=/path/seed.json API_PID=<pid> WORKER_PID=<pid> LOAD_ADMIN_URL=postgres://... DURATION=30 CONCURRENCY=16 \
//   SCENARIOS=login,search,analytics,alerts,mixed,reports,ingestion,ai OUT=/path/results.json node scripts/load/run.mjs
// Reports latency p50/p95/p99/max, throughput, error counts by status, API/worker CPU and RSS, and PostgreSQL activity.
// Results describe THIS machine and dataset only; see docs/LOAD_TESTING.md before drawing capacity conclusions.
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { cpus, totalmem } from 'node:os';

const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const { Client } = require('pg');

const seed = JSON.parse(readFileSync(process.env.SEED ?? 'load-seed.json', 'utf8'));
const DURATION = Number(process.env.DURATION ?? 30) * 1000;
const CONC = Number(process.env.CONCURRENCY ?? 16);
const SCENARIOS = (process.env.SCENARIOS ?? 'login,search,analytics,alerts,mixed,reports,ingestion,ai').split(',');
const pids = { api: Number(process.env.API_PID || 0), worker: Number(process.env.WORKER_PID || 0) };
const ADMIN = process.env.LOAD_ADMIN_URL;
const API = seed.api;

// ---------- HTTP ----------
async function req(method, path, { cookie, body } = {}) {
  const t = performance.now();
  try {
    const res = await fetch(`${API}/api/v1${path}`, {
      method, headers: { 'content-type': 'application/json', origin: seed.origin, ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, ms: performance.now() - t, body: text, cookie: res.headers.getSetCookie?.()[0]?.split(';')[0] };
  } catch (e) {
    return { status: 0, ms: performance.now() - t, body: String(e) };
  }
}
const json = (r) => { try { return JSON.parse(r.body); } catch { return null; } };

// ---------- Sampling ----------
const CLK = 100; // USER_HZ on Linux
function procStat(pid) {
  if (!pid) return null;
  try {
    const f = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
    const rss = Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))[1]) * 1024;
    return { cpu: (Number(f[11]) + Number(f[12])) / CLK, rss };
  } catch { return null; }
}
async function pgStat(c) {
  if (!c) return null;
  const r = (await c.query(`SELECT sum(xact_commit + xact_rollback)::bigint AS xacts, sum(blks_read)::bigint AS blks_read, sum(blks_hit)::bigint AS blks_hit,
    sum(tup_returned)::bigint AS tup_returned, sum(temp_bytes)::bigint AS temp_bytes, sum(deadlocks)::bigint AS deadlocks,
    (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND state = 'active') AS active,
    (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()) AS conns
    FROM pg_stat_database WHERE datname = current_database()`)).rows[0];
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v)]));
}
function sampler(pg) {
  const samples = []; let stop = false;
  const start = { api: procStat(pids.api), worker: procStat(pids.worker), t: performance.now() };
  let pg0 = null;
  const loop = (async () => {
    pg0 = await pgStat(pg);
    while (!stop) {
      const s = { api: procStat(pids.api), worker: procStat(pids.worker), pg: await pgStat(pg) };
      samples.push(s);
      await new Promise((r) => setTimeout(r, 1000));
    }
  })();
  return async () => {
    stop = true; await loop;
    const end = { api: procStat(pids.api), worker: procStat(pids.worker), t: performance.now() };
    const secs = (end.t - start.t) / 1000;
    const proc = (k) => (start[k] && end[k] ? {
      cpuPctOfOneCore: +(100 * (end[k].cpu - start[k].cpu) / secs).toFixed(1),
      rssMaxMB: +(Math.max(...samples.map((s) => s[k]?.rss ?? 0), end[k].rss) / 1048576).toFixed(0),
    } : null);
    const last = samples.at(-1)?.pg; const db = pg0 && last ? {
      xactsPerSec: +((last.xacts - pg0.xacts) / secs).toFixed(0),
      cacheHitPct: +(100 * (last.blks_hit - pg0.blks_hit) / Math.max(1, (last.blks_hit - pg0.blks_hit) + (last.blks_read - pg0.blks_read))).toFixed(2),
      blocksReadFromDisk: last.blks_read - pg0.blks_read, tempMB: +((last.temp_bytes - pg0.temp_bytes) / 1048576).toFixed(1),
      deadlocks: last.deadlocks - pg0.deadlocks, maxActive: Math.max(...samples.map((s) => s.pg?.active ?? 0)), maxConnections: Math.max(...samples.map((s) => s.pg?.conns ?? 0)),
    } : null;
    return { api: proc('api'), worker: proc('worker'), db };
  };
}

// ---------- Closed-loop driver ----------
const pct = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] : null);
function summarize(lat, statuses, secs) {
  lat.sort((a, b) => a - b);
  const ok = Object.entries(statuses).filter(([s]) => (s >= 200 && s < 400) || s === 'succeeded').reduce((n, [, v]) => n + v, 0);
  const r = (x) => (x == null ? null : +x.toFixed(1));
  return { requests: lat.length, okRate: +(ok / Math.max(1, lat.length)).toFixed(4), rps: +(lat.length / secs).toFixed(1),
    p50: r(pct(lat, 50)), p95: r(pct(lat, 95)), p99: r(pct(lat, 99)), max: r(lat.at(-1)), statuses };
}
async function closedLoop(name, conc, pick, pg) {
  const lat = []; const statuses = {}; const byOp = {};
  const end = Date.now() + DURATION; const stop = sampler(pg); const t0 = performance.now();
  await Promise.all(Array.from({ length: conc }, async (_, w) => {
    let i = 0;
    while (Date.now() < end) {
      const [op, fn] = pick(w, i++);
      const r = await fn();
      lat.push(r.ms); statuses[r.status] = (statuses[r.status] ?? 0) + 1;
      (byOp[op] ??= []).push(r.ms);
    }
  }));
  const secs = (performance.now() - t0) / 1000;
  const resources = await stop();
  const ops = Object.fromEntries(Object.entries(byOp).map(([k, v]) => { v.sort((a, b) => a - b); return [k, { n: v.length, p50: +pct(v, 50).toFixed(1), p95: +pct(v, 95).toFixed(1) }]; }));
  return { scenario: name, concurrency: conc, durationS: +secs.toFixed(1), ...summarize(lat, statuses, secs), ops, resources };
}

// ---------- Synthetic feed server (ingestion scenario) ----------
function feedServer(itemsPerFeed) {
  const stamp = Date.now();
  const srv = createServer((q, res) => {
    const id = (q.url ?? '').replace(/[^0-9a-z-]/gi, '');
    const items = Array.from({ length: itemsPerFeed }, (_, k) => `<item><title>Banjir sintetis ${id} ${stamp} #${k}</title>
      <link>https://feed.load.test/${id}/${stamp}/${k}</link><guid>${id}-${stamp}-${k}</guid><pubDate>${new Date(Date.now() - k * 60000).toUTCString()}</pubDate>
      <description>Ringkasan sintetis uji beban ${k}: banjir melanda wilayah contoh.</description></item>`).join('');
    res.writeHead(200, { 'content-type': 'application/rss+xml' });
    res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>Load ${id}</title>${items}</channel></rss>`);
  });
  const port = Number(new URL(seed.feedBase).port);
  return new Promise((r) => srv.listen(port, '127.0.0.1', () => r(srv)));
}

// ---------- Main ----------
const pg = ADMIN ? new Client({ connectionString: ADMIN }) : null;
if (pg) await pg.connect();
const tenants = seed.tenants;
for (const t of tenants) {
  const r = await req('POST', '/auth/login', { body: { email: t.email, password: t.password } });
  if (r.status !== 200 || !r.cookie) throw new Error(`login failed for a seeded tenant (${r.status})`);
  t.cookie = r.cookie;
}
const T = (w) => tenants[w % tenants.length];
const DAYS = [7, 30, 90];
const METRICS = ['overview', 'sentiment', 'topics', 'sources', 'share-of-voice', 'coverage'];
const ops = {
  search: (t, i) => ['mentions.search', () => req('GET', `/organizations/${t.org}/mentions?${new URLSearchParams(
    i % 3 === 0 ? { q: 'banjir', limit: '50' } : i % 3 === 1 ? { limit: '50', offset: String((i * 50) % 2000) } : { q: 'harga beras', sentiment: 'negative', limit: '25' })}`, { cookie: t.cookie })],
  analytics: (t, i) => { const m = METRICS[i % METRICS.length]; return [`analytics.${m}`, () => req('GET', `/organizations/${t.org}/analytics/${m}?days=${DAYS[(i >> 2) % 3]}`, { cookie: t.cookie })]; },
  alerts: (t, i) => (i % 2 ? ['issues.dashboard', () => req('GET', `/organizations/${t.org}/issues/dashboard`, { cookie: t.cookie })]
    : ['alert-rules.list', () => req('GET', `/organizations/${t.org}/alert-rules`, { cookie: t.cookie })]),
};
const results = { startedAt: new Date().toISOString(), host: { cpus: cpus().length, cpuModel: cpus()[0]?.model, memGB: +(totalmem() / 2 ** 30).toFixed(1), node: process.version },
  dataset: { tenants: tenants.length, mentionsPerTenant: seed.perTenant }, config: { durationS: DURATION / 1000, concurrency: CONC }, scenarios: [] };
const log = (r) => { results.scenarios.push(r); console.log(JSON.stringify({ scenario: r.scenario, conc: r.concurrency, rps: r.rps, p50: r.p50, p95: r.p95, p99: r.p99, okRate: r.okRate, statuses: r.statuses })); };

for (const s of SCENARIOS) {
  if (s === 'login') {
    // Password verification (scrypt) is deliberately expensive; run at low concurrency against seeded accounts.
    log(await closedLoop('auth.login', Math.min(CONC, 4), (w) => { const t = T(w); return ['auth.login', () => req('POST', '/auth/login', { body: { email: t.email, password: t.password } })]; }, pg));
  } else if (s === 'search' || s === 'analytics' || s === 'alerts') {
    log(await closedLoop(s, CONC, (w, i) => ops[s](T(w), i), pg));
  } else if (s === 'mixed') {
    // Concurrent tenants: every worker rotates tenants and operations (search, analytics, alerts).
    const kinds = ['search', 'analytics', 'analytics', 'alerts'];
    log(await closedLoop('mixed.concurrent-tenants', CONC * 2, (w, i) => ops[kinds[(w + i) % kinds.length]](T(w + i), i), pg));
  } else if (s === 'reports') {
    // Enqueue one weekly report per tenant (×REPORTS_PER_TENANT) and measure enqueue→terminal time through the worker.
    const per = Number(process.env.REPORTS_PER_TENANT ?? 2); const stop = sampler(pg); const t0 = performance.now(); const runs = [];
    for (let k = 0; k < per; k++) for (const t of tenants) {
      const to = new Date(Date.now() - k * 7 * 864e5); const from = new Date(to.getTime() - 7 * 864e5);
      const r = await req('POST', `/organizations/${t.org}/reports/definitions/${t.reportDefinition}/generate`, { cookie: t.cookie, body: { periodStart: from.toISOString(), periodEnd: to.toISOString() } });
      runs.push({ t, status: r.status, id: json(r)?.id ?? json(r)?.run?.id, start: performance.now(), body: r.status >= 300 ? r.body.slice(0, 160) : undefined });
    }
    const durations = []; const outcomes = {};
    for (const run of runs.filter((x) => x.id)) {
      for (;;) {
        const r = json(await req('GET', `/organizations/${run.t.org}/reports/runs/${run.id}`, { cookie: run.t.cookie }));
        const st = r?.status ?? r?.run?.status;
        if (['succeeded', 'failed', 'cancelled', 'partial'].includes(st)) { outcomes[st] = (outcomes[st] ?? 0) + 1; durations.push(performance.now() - run.start); break; }
        if (performance.now() - run.start > 600_000) { outcomes.timeout = (outcomes.timeout ?? 0) + 1; break; }
        await new Promise((x) => setTimeout(x, 250));
      }
    }
    const secs = (performance.now() - t0) / 1000;
    log({ scenario: 'reports.generate', concurrency: runs.length, durationS: +secs.toFixed(1), ...summarize(durations, outcomes, secs),
      enqueueStatuses: runs.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {}), enqueueErrors: runs.filter((r) => r.body).map((r) => r.body), resources: await stop() });
  } else if (s === 'ingestion') {
    // Collect every source once from the local synthetic feed server; measure trigger→run finished.
    const items = Number(process.env.FEED_ITEMS ?? 200); const srv = await feedServer(items); const stop = sampler(pg); const t0 = performance.now();
    const jobs = [];
    for (const t of tenants) for (const sid of t.sources) {
      await req('POST', `/organizations/${t.org}/sources/${sid}/enable`, { cookie: t.cookie });
      const r = await req('POST', `/organizations/${t.org}/sources/${sid}/collect`, { cookie: t.cookie });
      jobs.push({ t, sid, status: r.status, start: performance.now(), wall: Date.now(), body: r.status >= 300 ? r.body.slice(0, 160) : undefined });
    }
    const durations = []; const outcomes = {}; let collected = 0;
    for (const j of jobs.filter((x) => x.status < 300)) {
      for (;;) {
        const runs = json(await req('GET', `/organizations/${j.t.org}/sources/${j.sid}/runs`, { cookie: j.t.cookie }));
        const list = Array.isArray(runs) ? runs : [];
        const run = list.find((x) => new Date(x.created_at).getTime() >= j.wall - 2000);
        if (run && ['succeeded', 'failed', 'dead_lettered'].includes(run.status)) {
          outcomes[run.status] = (outcomes[run.status] ?? 0) + 1; durations.push(performance.now() - j.start); collected += Number(run.records_new ?? 0); break;
        }
        if (performance.now() - j.start > 300_000) { outcomes.timeout = (outcomes.timeout ?? 0) + 1; break; }
        await new Promise((x) => setTimeout(x, 250));
      }
    }
    srv.close();
    const secs = (performance.now() - t0) / 1000;
    log({ scenario: 'ingestion.collect', concurrency: jobs.length, durationS: +secs.toFixed(1), ...summarize(durations, outcomes, secs), itemsPerFeed: items,
      itemsInserted: collected, triggerErrors: jobs.filter((j) => j.body).map((j) => `${j.status} ${j.body}`), resources: await stop() });
  } else if (s === 'ai') {
    // Baseline (non-LLM) analysis queue: request a backfill per tenant, then measure how fast the worker drains it.
    const stop = sampler(pg); const t0 = performance.now(); const queued = {};
    for (const t of tenants) {
      const r = await req('POST', `/organizations/${t.org}/analysis/backfill`, { cookie: t.cookie, body: { scope: 'pending', limit: 500 } });
      queued[t.org] = { status: r.status, ...(json(r) ?? {}) };
    }
    const total = Object.values(queued).reduce((n, q) => n + (q.queued ?? 0), 0);
    let remaining = total;
    while (pg && remaining > 0 && performance.now() - t0 < 600_000) {
      remaining = Number((await pg.query(`SELECT count(*) FROM mention_analyses WHERE status IN ('queued','running') AND tenant_id = ANY($1)`, [tenants.map((t) => t.org)])).rows[0].count);
      await new Promise((x) => setTimeout(x, 500));
    }
    const secs = (performance.now() - t0) / 1000;
    log({ scenario: 'ai.baseline-backfill', concurrency: tenants.length, durationS: +secs.toFixed(1), requests: total, rps: +(total / secs).toFixed(1),
      okRate: remaining === 0 ? 1 : +(1 - remaining / Math.max(1, total)).toFixed(4), statuses: Object.fromEntries(Object.values(queued).map((q, k) => [`tenant${k}`, `${q.status} queued=${q.queued ?? 0}`])),
      remaining, resources: await stop() });
  }
}
if (pg) await pg.end();
results.finishedAt = new Date().toISOString();
if (process.env.OUT) writeFileSync(process.env.OUT, JSON.stringify(results, null, 2));
console.log(`done: ${results.scenarios.length} scenario(s)${process.env.OUT ? `, results in ${process.env.OUT}` : ''}`);
