import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { INestApplication } from '@nestjs/common';
import type { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { Client } from 'pg';
import { SMTPServer } from 'smtp-server';
import request from 'supertest';
import { ALERTS_QUEUE, AlertsEnqueuer, createAlertsWorker, type AlertJob } from '../../src/alerts/alerts-queue';
import { EmailChannel } from '../../src/alerts/channels/email';
import { verifyWebhookSignature } from '../../src/alerts/channels/webhook';
import { CLOCK, type Clock } from '../../src/alerts/clock';
import { EvaluatorService } from '../../src/alerts/evaluator.service';
import { IssueSummaryService } from '../../src/alerts/issue-summary.service';
import { NotificationService } from '../../src/alerts/notifications.service';
import { AppConfig, CONFIG } from '../../src/config';
import { OWNER_URL } from '../env';
import { addMember, createOrg, registerUser, testApp, TEST_REDIS_URL, TestUser } from '../helpers';

/**
 * Issue detection and alerting against real PostgreSQL and Redis, a local SMTP server and a local webhook receiver.
 * Coverage is synthetic and deterministic (inserted fixtures, labelled as such); time comes from a controllable clock.
 */
const H = 3_600_000; const D = 24 * H;
const NOW = Date.UTC(2026, 9, 19, 5, 0, 0);   // 12:00 in Jakarta

describe('issue detection and alerting (e2e)', () => {
  let app: INestApplication; let db: Client; let redis: IORedis; let smtp: SMTPServer; let hook: Server;
  let evaluator: EvaluatorService; let notifications: NotificationService; let enqueuer: AlertsEnqueuer; let clock: Clock;
  let t = NOW;
  const http = () => request(app.getHttpServer());
  let owner: TestUser; let analyst: TestUser; let viewer: TestUser; let pm: TestUser; let unassigned: TestUser; let outsider: TestUser;
  let org: string; let otherOrg: string; let project: string; let queryId: string; let sourceId: string; let connectorId: string;
  const mail: Array<{ to: string; raw: string }> = [];
  let smtpMode: 'accept' | 'temp' | 'perm' = 'accept';
  const hooks: Array<{ headers: Record<string, string | string[] | undefined>; body: string }> = [];
  let hookMode: 'ok' | 'fail' = 'ok';
  let hookUrl = '';
  let seq = 0;

  const api = (u: TestUser) => ({
    get: (p: string) => http().get(`/api/v1/organizations/${org}${p}`).set('Cookie', u.cookie),
    post: (p: string, b: object = {}) => http().post(`/api/v1/organizations/${org}${p}`).set('Cookie', u.cookie).send(b),
    patch: (p: string, b: object = {}) => http().patch(`/api/v1/organizations/${org}${p}`).set('Cookie', u.cookie).send(b),
    put: (p: string, b: object = {}) => http().put(`/api/v1/organizations/${org}${p}`).set('Cookie', u.cookie).send(b),
    del: (p: string) => http().delete(`/api/v1/organizations/${org}${p}`).set('Cookie', u.cookie),
  });

  /** Synthetic record with analysis (sentiment/topics) and a project match. */
  async function mention(at: number, o: { publisher?: string; title?: string; label?: string; uncertain?: boolean; topics?: string[]; excerpt?: string } = {}) {
    const id = randomUUID(); seq++;
    const title = o.title ?? `Synthetic report ${seq} about the water supply`;
    await db.query(`INSERT INTO mentions (id, tenant_id, source_id, url, canonical_url, title, excerpt, content_hash, publisher_domain, publisher, published_at, discovered_at, provenance)
      VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,$8,$9,$9,'{"fixture":"alerts.e2e synthetic"}')`,
      [id, org, sourceId, `https://${o.publisher ?? 'pub1.example'}/a/${id}`, title, o.excerpt ?? null, randomBytes(8).toString('hex'), o.publisher ?? 'pub1.example', new Date(at)]);
    await db.query('INSERT INTO mention_matches (tenant_id, mention_id, project_id, query_id) VALUES ($1,$2,$3,$4)', [org, id, project, queryId]);
    if (o.label) {
      const a = (await db.query(`INSERT INTO mention_analyses (tenant_id, mention_id, idempotency_key, trigger, status, provider, model, method, pipeline_version, is_current, finished_at)
        VALUES ($1,$2,'fixture','backfill','succeeded','test','test-fixture','test','ai-pipeline/2',true,$3) RETURNING id`, [org, id, new Date(at)])).rows[0].id;
      await db.query(`INSERT INTO sentiment_results (tenant_id, mention_id, label, confidence, model_version, target_type, uncertain, method, analysis_id)
        VALUES ($1,$2,$3,0.8,'test-fixture','article',$4,'test',$5)`, [org, id, o.label, o.uncertain ?? false, a]);
      for (const k of o.topics ?? []) await db.query(`INSERT INTO mention_topics (tenant_id, mention_id, topic_key, confidence, model_version, analysis_id, taxonomy_version) VALUES ($1,$2,$3,0.8,'test-fixture',$4,'gov-pa/1')`, [org, id, k, a]);
      await db.query('UPDATE mentions SET analysis_id = $2 WHERE id = $1', [id, a]);
    }
    return id;
  }
  const rule = (body: object) => api(owner).post('/alert-rules', { projectId: project, ...body });
  const evaluate = () => evaluator.evaluateTenant(org, 'test', { bucketKey: `t${t}` });
  const deliveries = (issueId: string) => db.query('SELECT * FROM notification_deliveries WHERE issue_id = $1 ORDER BY created_at, channel', [issueId]).then((r) => r.rows);
  const until = async <T>(fn: () => Promise<T | null | undefined | false>, ms = 15000): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('condition not met in time'); await new Promise((r) => setTimeout(r, 100)); }
  };

  beforeAll(async () => {
    redis = new IORedis(TEST_REDIS_URL, { maxRetriesPerRequest: null }); await redis.flushdb();
    smtp = new SMTPServer({ authOptional: true, disabledCommands: ['STARTTLS', 'AUTH'], logger: false,
      onData(stream, session, cb) {
        let raw = ''; stream.on('data', (c: Buffer) => { raw += c.toString(); });
        stream.on('end', () => {
          if (smtpMode === 'temp') return cb(Object.assign(new Error('Try again later'), { responseCode: 451 }));
          if (smtpMode === 'perm') return cb(Object.assign(new Error('Mailbox unavailable'), { responseCode: 550 }));
          mail.push({ to: session.envelope.rcptTo.map((r) => r.address).join(','), raw }); cb();
        });
      } });
    await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', () => r()));
    const smtpPort = (smtp.server.address() as AddressInfo).port;
    hook = createServer((req, res) => {
      let body = ''; req.on('data', (c) => { body += c; });
      req.on('end', () => {
        hooks.push({ headers: req.headers, body });
        if (hookMode === 'fail') { res.statusCode = 503; return res.end(); }
        const parsed = JSON.parse(body);
        res.setHeader('content-type', 'application/json');
        res.end(parsed.type === 'webhook.verification' ? JSON.stringify({ challenge: parsed.challenge }) : '{}');
      });
    });
    await new Promise<void>((r) => hook.listen(0, '127.0.0.1', () => r()));
    hookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/civicsignal`;
    app = await testApp({ REDIS_URL: TEST_REDIS_URL, INGESTION_ALLOW_PRIVATE_HOSTS: 'true', ALERTS_WEBHOOK_ALLOW_HTTP: 'true', AI_PROVIDER: 'baseline',
      CREDENTIALS_KEY: randomBytes(32).toString('base64'), SMTP_URL: `smtp://127.0.0.1:${smtpPort}/?ignoreTLS=true`, EMAIL_FROM: 'alerts@civicsignal.test',
      ALERTS_BACKOFF_BASE_MS: '50', ALERTS_DELIVERY_ATTEMPTS: '3', APP_BASE_URL: 'https://app.civicsignal.test' });
    clock = app.get(CLOCK);
    (clock as { now: () => Date }).now = () => new Date(t);
    evaluator = app.get(EvaluatorService); notifications = app.get(NotificationService); enqueuer = app.get(AlertsEnqueuer);
    db = new Client({ connectionString: OWNER_URL }); await db.connect();
    owner = await registerUser(app, 'Alert Owner'); org = await createOrg(app, owner);
    analyst = await addMember(app, owner, org, 'analyst', 'Analyst'); viewer = await addMember(app, owner, org, 'report_viewer', 'Viewer');
    pm = await addMember(app, owner, org, 'project_manager', 'PM'); unassigned = await addMember(app, owner, org, 'analyst', 'Unassigned');
    outsider = await registerUser(app, 'Outsider'); otherOrg = await createOrg(app, outsider);
    project = (await api(owner).post('/projects', { name: 'Air bersih' }).expect(201)).body.id;
    queryId = (await api(owner).post(`/projects/${project}/queries`, { name: 'Air', keywords: ['water'] }).expect(201)).body.id;
    for (const u of [analyst, viewer, pm]) await api(owner).post(`/projects/${project}/members`, { userId: u.id }).expect(204);
    sourceId = (await api(owner).post('/sources', { kind: 'feed', name: 'Fixture feed', feedUrl: 'https://feeds.example/rss', authorizationStatus: 'authorized', authorizationBasis: 'Synthetic test fixture' }).expect(201)).body.id;
    connectorId = (await db.query('SELECT id FROM connectors WHERE source_id = $1', [sourceId])).rows[0].id;
    // Hourly successful collection for 15 days, except a gap 9 days ago (collector down for the whole day).
    await db.query(`INSERT INTO connector_runs (tenant_id, connector_id, source_id, idempotency_key, status, finished_at, started_at)
      SELECT $1, $2, $3, 'fx' || g::text, 'succeeded', g, g FROM generate_series($4::timestamptz - interval '15 days', $4::timestamptz, interval '1 hour') g
      WHERE NOT (g >= $4::timestamptz - interval '9 days 12 hours' AND g < $4::timestamptz - interval '8 days 12 hours')`, [org, connectorId, sourceId, new Date(NOW)]);
    // Baseline: 2–4 records in the same hour each previous day.
    for (let k = 1; k <= 14; k++) {
      if (k === 9) continue;
      for (let j = 0; j < 2 + (k % 3); j++) await mention(NOW - k * D - 20 * 60_000 - j * 60_000, { publisher: `pub${j}.example`, label: 'neutral', topics: ['public_services'] });
    }
  });

  afterAll(async () => {
    await app.get<Queue<AlertJob>>(ALERTS_QUEUE).obliterate({ force: true }).catch(() => undefined);
    await app.close(); await db.end(); redis.disconnect(); smtp.close(); hook.close();
  });

  let spikeRule: string; let spikeIssue: string;

  describe('rules', () => {
    it('validates configuration server-side with field-level errors', async () => {
      const r = await rule({ name: 'Bad', ruleType: 'keyword', config: { filters: { keywords: '(water OR' } } }).expect(400);
      expect(r.body.error.details).toEqual([{ field: 'filters.keywords', problems: [expect.any(String)] }]);
      await rule({ name: 'Bad', ruleType: 'volume_spike', config: { notify: { channels: ['email'], recipientUserIds: [outsider.id] } } }).expect(400);
      // Report viewers cannot read alerts, so they cannot be recipients either.
      await rule({ name: 'Bad', ruleType: 'volume_spike', config: { notify: { channels: ['in_app'], recipientUserIds: [viewer.id] } } }).expect(400);
      await rule({ name: 'Bad', ruleType: 'volume_spike', config: { filters: { entityIds: [randomUUID()] } } }).expect(400);
      await rule({ name: 'Bad', ruleType: 'volume_spike', config: { unexpected: true } }).expect(400);
    });
    it('only alerts:manage roles create rules; tenant-isolated', async () => {
      await api(analyst).post('/alert-rules', { projectId: project, name: 'x', ruleType: 'volume_spike' }).expect(403);
      await api(viewer).get('/alert-rules').expect(403);
      await http().get(`/api/v1/organizations/${org}/alert-rules`).set('Cookie', outsider.cookie).expect(404);
    });
    it('creates a volume rule (version 1) and a dry run creates nothing', async () => {
      const r = await rule({ name: 'Water volume', ruleType: 'volume_spike', config: {
        window: { minutes: 60, comparison: 'same_time_previous_days', baselineWindows: 14 }, thresholds: { minMentions: 8, relativeChange: 2, robustZ: 3, minBaselineWindows: 5 },
        notify: { channels: ['in_app', 'email'], recipientUserIds: [owner.id, analyst.id] }, cooldownMinutes: 120 } }).expect(201);
      spikeRule = r.body.id;
      expect(r.body.version).toBe(1);
      for (let i = 0; i < 24; i++) await mention(NOW - 40 * 60_000 + i * 60_000, { publisher: `pub${i % 6}.example`, label: i % 3 === 0 ? 'negative' : 'neutral', topics: ['public_services'] });
      const dry = await api(owner).post(`/alert-rules/${spikeRule}/test`).expect(200);
      expect(dry.body.results[0]).toMatchObject({ triggered: true, method: 'robust-z/median-MAD', exceeded: ['minMentions', 'relativeChange', 'robustZ'] });
      expect(dry.body.results[0].limitations.join(' ')).toMatch(/1 of 14 comparison windows had no successful collection/);
      expect((await db.query('SELECT count(*)::int AS n FROM detected_issues WHERE tenant_id = $1', [org])).rows[0].n).toBe(0);
    });
  });

  describe('detection, evidence and notifications', () => {
    it('evaluates persisted mentions into an explainable issue with evidence', async () => {
      const r = await evaluate();
      expect(r.created).toBe(1);
      spikeIssue = r.outcomes.find((o) => o.ruleId === spikeRule)!.issueId!;
      const d = (await api(analyst).get(`/issues/${spikeIssue}`).expect(200)).body;
      expect(d.issue).toMatchObject({ status: 'pending_review', scope: 'issue', signal: 'volume_spike', rule_version: 1 });
      expect(d.issue.detection).toMatchObject({ method: 'robust-z/median-MAD', baseline: { median: 3, windows: 13 }, observed: { mentions: 24 } });
      expect(d.issue.detection.reviewSteps.length).toBeGreaterThanOrEqual(2);
      expect(d.issue.severity_breakdown.factors.map((f: { factor: string }) => f.factor)).toContain('independent_publishers');
      expect(d.totals).toMatchObject({ records: 24, publishers: 6, independent_publishers: 6 });
      expect(d.evidence[0].url).toMatch(/^https:\/\/pub\d\.example\/a\//);
      expect(d.events.map((e: { event: string }) => e.event)).toEqual(expect.arrayContaining(['detected', 'status_changed', 'notified']));
      expect(d.rule).toMatchObject({ version: 1, name: 'Water volume' });
      expect(d.disclaimer).toMatch(/not verified facts/);
    });
    it('in-app notifications go to the configured recipients; email rows are queued by severity preference', async () => {
      const rows = await deliveries(spikeIssue);
      const inApp = rows.filter((x) => x.channel === 'in_app');
      expect(inApp.map((x) => x.user_id).sort()).toEqual([owner.id, analyst.id].sort());
      expect(inApp.every((x) => x.status === 'delivered')).toBe(true);
      const sev = (await db.query('SELECT severity FROM detected_issues WHERE id = $1', [spikeIssue])).rows[0].severity;
      const email = rows.filter((x) => x.channel === 'email');
      expect(email.length).toBe(['medium', 'high', 'critical'].includes(sev) ? 2 : 0);
      const inbox = (await api(analyst).get('/notifications?unread=true').expect(200)).body;
      expect(inbox.unread).toBe(1);
      expect(inbox.items[0].payload).toMatchObject({ link: `https://app.civicsignal.test/o/${org}/alerts/${spikeIssue}` });
      await api(analyst).patch(`/notifications/${inbox.items[0].id}`, { read: true }).expect(200);
      expect((await api(analyst).get('/notifications?unread=true').expect(200)).body.unread).toBe(0);
      await api(owner).patch(`/notifications/${inbox.items[0].id}`, { read: true }).expect(404);   // not the owner's notification
    });
    it('email is delivered end to end through SMTP (HTML + text, source links, no header injection)', async () => {
      const ids = (await deliveries(spikeIssue)).filter((x) => x.channel === 'email').map((x) => x.id);
      for (const id of ids) await notifications.deliver(org, id, 1, false);
      expect(mail.length).toBe(ids.length);
      expect(mail[0]!.raw).toMatch(/Subject: \[CivicSignal (MEDIUM|HIGH|CRITICAL)\]/);
      expect(mail[0]!.raw).toMatch(/Content-Type: text\/html/);
      expect(mail[0]!.raw).toMatch(/Content-Type: text\/plain/);
      expect(mail[0]!.raw.replace(/=\r?\n/g, '')).toContain('https://app.civicsignal.test');   // quoted-printable soft breaks removed
      expect((await deliveries(spikeIssue)).filter((x) => x.channel === 'email').every((x) => x.status === 'delivered')).toBe(true);
    });
    it('re-evaluating the same bucket is a no-op; a new bucket without new data changes nothing', async () => {
      expect((await evaluator.evaluateTenant(org, 'test', { bucketKey: `t${t}` })).evaluationId).toBeNull();
      const before = (await deliveries(spikeIssue)).length;
      t += 5 * 60_000;
      const r = await evaluate();
      expect(r.outcomes.find((o) => o.ruleId === spikeRule)!.action).toBe('unchanged');
      expect((await deliveries(spikeIssue)).length).toBe(before);
      expect((await db.query('SELECT count(*)::int AS n FROM detected_issues WHERE rule_id = $1', [spikeRule])).rows[0].n).toBe(1);
    });
    it('new evidence updates the same issue (no duplicate alert, no repeat notification)', async () => {
      await mention(t - 60_000, { publisher: 'pub2.example', label: 'neutral' });
      t += 5 * 60_000;
      const r = await evaluate();
      expect(r.outcomes.find((o) => o.ruleId === spikeRule)).toMatchObject({ action: 'updated', issueId: spikeIssue });
      const i = (await db.query('SELECT occurrence_count FROM detected_issues WHERE id = $1', [spikeIssue])).rows[0];
      expect(i.occurrence_count).toBe(2);
      expect((await deliveries(spikeIssue)).filter((x) => x.kind === 'detected').length).toBe((await deliveries(spikeIssue)).length);
    });
  });

  describe('suppression and data quality', () => {
    it('low-sample and uncertain-classification rules are suppressed and recorded in the evaluation ledger', async () => {
      const neg = (await rule({ name: 'Tone', ruleType: 'negative_shift', config: { window: { minutes: 60 }, thresholds: { minClassified: 100 } } }).expect(201)).body.id;
      const thin = (await rule({ name: 'Thin baseline', ruleType: 'volume_spike', config: { window: { minutes: 1440, comparison: 'previous_windows', baselineWindows: 60 }, thresholds: { minBaselineWindows: 30, minMentions: 1 } } }).expect(201)).body.id;
      t += 5 * 60_000;
      const r = await evaluate();
      expect(r.outcomes.find((o) => o.ruleId === neg)!.suppressed).toMatch(/insufficient_sample/);
      expect(r.outcomes.find((o) => o.ruleId === thin)).toMatchObject({ triggered: false, suppressed: expect.stringMatching(/^insufficient_baseline/) });
      const ledger = (await db.query('SELECT suppressed FROM alert_evaluations WHERE id = $1', [r.evaluationId])).rows[0].suppressed;
      expect(ledger.map((x: { ruleId: string }) => x.ruleId)).toEqual(expect.arrayContaining([neg]));
      for (let i = 0; i < 30; i++) await mention(t - 30 * 60_000, { publisher: `u${i}.example`, label: 'negative', uncertain: true });
      await api(owner).patch(`/alert-rules/${neg}`, { config: { window: { minutes: 60 }, thresholds: { minClassified: 20 } } }).expect(200);
      expect((await api(owner).post(`/alert-rules/${neg}/test`).expect(200)).body.results[0].suppressed.reason).toBe('classification_uncertain');
      await api(owner).del(`/alert-rules/${neg}`).expect(204); await api(owner).del(`/alert-rules/${thin}`).expect(204);
    });
  });

  describe('keyword rule, severity floor and quiet hours', () => {
    it('a critical keyword rule applies its floor; email during quiet hours is deferred (non-critical)', async () => {
      const r = (await rule({ name: 'Contamination', ruleType: 'keyword', config: { filters: { keywords: 'contamination OR "boil water"' }, thresholds: { minMentions: 1 },
        window: { minutes: 120, comparison: 'previous_windows' }, severity: { floor: 'high', minimum: 'low' },
        notify: { channels: ['in_app', 'email'], recipientUserIds: [owner.id] }, quietHours: { start: '11:00', end: '13:00', timezone: 'Asia/Jakarta', allowCritical: true } } }).expect(201)).body.id;
      await mention(t - 10 * 60_000, { title: 'Boil water advisory after contamination found', publisher: 'pub3.example', label: 'negative' });
      t += 5 * 60_000;
      const out = await evaluate();
      const o = out.outcomes.find((x) => x.ruleId === r)!;
      expect(o).toMatchObject({ triggered: true, action: 'created', severity: 'high' });
      const issue = (await api(owner).get(`/issues/${o.issueId}`).expect(200)).body.issue;
      expect(issue.scope).toBe('article');
      expect(issue.severity_breakdown.caps.join(' ')).toMatch(/rule floor raises/);
      const email = (await deliveries(o.issueId!)).find((x) => x.channel === 'email')!;
      expect(email.status).toBe('deferred');
      expect(new Date(email.not_before).toISOString()).toBe('2026-10-19T06:00:00.000Z');   // 13:00 WIB
      expect(await notifications.deliver(org, email.id, 1, false)).toMatchObject({ outcome: 'delay' });
    });
  });

  describe('rule versioning', () => {
    it('editing config creates a new version; existing issues stay explained by their version; deleted rules keep their issues', async () => {
      await api(owner).patch(`/alert-rules/${spikeRule}`, { config: { window: { minutes: 60 }, thresholds: { minMentions: 50 }, notify: { channels: ['in_app'], recipientUserIds: [owner.id, analyst.id] } } }).expect(200)
        .expect((x) => expect(x.body.version).toBe(2));
      await api(owner).patch(`/alert-rules/${spikeRule}`, { name: 'Water volume (renamed)' }).expect(200).expect((x) => expect(x.body.version).toBe(2));
      const rr = (await api(owner).get(`/alert-rules/${spikeRule}`).expect(200)).body;
      expect(rr.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
      const d = (await api(owner).get(`/issues/${spikeIssue}`).expect(200)).body;
      expect(d.rule).toMatchObject({ version: 1, current_version: 2 });
      expect(d.rule.config.thresholds.minMentions).toBe(8);
    });
  });

  describe('lifecycle and permissions', () => {
    it('acknowledge → assign → investigate → resolve, with audit and notes; invalid transitions rejected', async () => {
      await api(viewer).post(`/issues/${spikeIssue}/acknowledge`).expect(403);
      await api(unassigned).get(`/issues/${spikeIssue}`).expect(404);   // not assigned to the project
      await http().get(`/api/v1/organizations/${otherOrg}/issues/${spikeIssue}`).set('Cookie', outsider.cookie).expect(404);
      await api(analyst).post(`/issues/${spikeIssue}/resolve`, { reason: 'x' }).expect(400);           // reason too short
      await api(analyst).post(`/issues/${spikeIssue}/acknowledge`).expect(200);
      await api(analyst).post(`/issues/${spikeIssue}/acknowledge`).expect(409);
      await api(analyst).post(`/issues/${spikeIssue}/assign`, { userId: unassigned.id }).expect(400);   // cannot see the project
      await api(analyst).post(`/issues/${spikeIssue}/assign`, { userId: pm.id }).expect(200);
      await api(analyst).post(`/issues/${spikeIssue}/investigate`).expect(200);
      await api(analyst).post(`/issues/${spikeIssue}/notes`, { body: 'Confirmed with the utility: maintenance outage.' }).expect(201);
      await api(viewer).post(`/issues/${spikeIssue}/notes`, { body: 'x' }).expect(403);
      await api(analyst).post(`/issues/${spikeIssue}/resolve`, { reason: 'Planned maintenance; utility statement published.' }).expect(200);
      await api(analyst).post(`/issues/${spikeIssue}/close`).expect(403);                                // alerts:manage
      const d = (await api(owner).get(`/issues/${spikeIssue}`).expect(200)).body;
      expect(d.issue).toMatchObject({ status: 'resolved', resolution_reason: 'Planned maintenance; utility statement published.', assigned_to: pm.id });
      expect(d.notes).toHaveLength(1);
      expect(d.assignments).toHaveLength(1);
      expect(d.events.map((e: { event: string }) => e.event)).toEqual(expect.arrayContaining(['status_changed', 'assigned', 'note_added']));
      const audit = (await db.query(`SELECT action, metadata FROM audit_events WHERE tenant_id = $1 AND target_id = $2 ORDER BY occurred_at`, [org, spikeIssue])).rows;
      expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['issue.acknowledged', 'issue.assigned', 'issue.investigating', 'issue.note_added', 'issue.resolved']));
      expect(JSON.stringify(audit)).not.toContain('maintenance outage');   // note content is not copied into the audit log
      expect((await deliveries(spikeIssue)).some((x) => x.kind === 'resolved')).toBe(true);
    });
    it('notes and history are append-only for the application role', async () => {
      const g = (await db.query(`SELECT has_table_privilege('civicsignal_app', 'alert_notes', 'UPDATE') AS nu, has_table_privilege('civicsignal_app', 'alert_events', 'DELETE') AS ed,
        has_table_privilege('civicsignal_app', 'alert_rule_versions', 'UPDATE') AS vu, has_table_privilege('civicsignal_app', 'detected_issues', 'DELETE') AS idel,
        has_table_privilege('civicsignal_app', 'alert_rules', 'DELETE') AS rdel`)).rows[0];
      expect(g).toEqual({ nu: false, ed: false, vu: false, idel: false, rdel: false });
    });
    it('new evidence after resolution reopens the issue automatically; cooldown prevents a repeat notification', async () => {
      await api(owner).patch(`/alert-rules/${spikeRule}`, { config: { window: { minutes: 60 }, thresholds: { minMentions: 8 }, notify: { channels: ['in_app'], recipientUserIds: [owner.id, analyst.id] }, cooldownMinutes: 120 } }).expect(200);
      await mention(t - 60_000, { publisher: 'pub4.example', label: 'neutral' });
      t += 5 * 60_000;
      const r = await evaluate();
      expect(r.outcomes.find((o) => o.ruleId === spikeRule)).toMatchObject({ action: 'reopened', issueId: spikeIssue });
      const d = (await api(owner).get(`/issues/${spikeIssue}`).expect(200)).body;
      expect(d.issue.status).toBe('pending_review');
      expect(d.events.some((e: { event: string; details: { automatic?: boolean } }) => e.event === 'reopened' && e.details.automatic)).toBe(true);
      expect((await deliveries(spikeIssue)).some((x) => x.kind === 'reopened')).toBe(false);   // within the 120-minute cooldown
    });
    it('manual close and reopen', async () => {
      await api(analyst).post(`/issues/${spikeIssue}/resolve`, { reason: 'Handled again.' }).expect(200);
      await api(owner).post(`/issues/${spikeIssue}/close`, { reason: 'Done' }).expect(200);
      await api(analyst).post(`/issues/${spikeIssue}/reopen`, { reason: 'Further complaints reported by the utility.' }).expect(200);
      await api(owner).post(`/issues/${spikeIssue}/close`).expect(409);   // pending_review cannot be closed directly
      await api(analyst).post(`/issues/${spikeIssue}/resolve`, { reason: 'Handled a third time.' }).expect(200);
      await api(owner).post(`/issues/${spikeIssue}/close`).expect(200);
    });
    it('a re-detection after close creates a new issue in the same group; cooldown suppresses its notification', async () => {
      await mention(t - 60_000, { publisher: 'pub5.example', label: 'neutral' });
      t += 5 * 60_000;
      const r = await evaluate();
      const o = r.outcomes.find((x) => x.ruleId === spikeRule)!;
      expect(o.action).toBe('created');
      expect(o.issueId).not.toBe(spikeIssue);
      expect((await deliveries(o.issueId!)).filter((x) => x.kind === 'detected')).toHaveLength(0);
      const list = (await api(owner).get(`/issues?projectId=${project}`).expect(200)).body;
      expect(list.items.find((x: { id: string }) => x.id === o.issueId).related_count).toBeGreaterThanOrEqual(1);
      await api(owner).post(`/issues/${spikeIssue}/reopen`, { reason: 'Trying to reopen the old one.' }).expect(409);   // newer issue open
    });
  });

  describe('escalation', () => {
    it('escalates an unacknowledged issue once per level', async () => {
      const r = (await rule({ name: 'Escalating keyword', ruleType: 'keyword', config: { filters: { keywords: 'outbreak' }, thresholds: { minMentions: 1 }, window: { minutes: 120, comparison: 'previous_windows' },
        severity: { floor: 'medium' }, notify: { channels: ['in_app'], recipientUserIds: [analyst.id] }, escalation: { steps: [{ afterMinutes: 30, notifyUserIds: [owner.id] }, { afterMinutes: 90, notifyUserIds: [owner.id, pm.id] }] } } }).expect(201)).body.id;
      await mention(t - 5 * 60_000, { title: 'Water-borne outbreak reported in two districts', publisher: 'pub1.example', label: 'negative' });
      t += 5 * 60_000;
      const issueId = (await evaluate()).outcomes.find((x) => x.ruleId === r)!.issueId!;
      t += 31 * 60_000; await evaluate(); t += 5 * 60_000; await evaluate();
      let ev = (await db.query(`SELECT details FROM alert_events WHERE issue_id = $1 AND event = 'escalated'`, [issueId])).rows;
      expect(ev).toHaveLength(1);
      expect((await deliveries(issueId)).filter((x) => x.kind === 'escalated').map((x) => x.user_id)).toEqual([owner.id]);
      t += 60 * 60_000; await evaluate();
      ev = (await db.query(`SELECT details FROM alert_events WHERE issue_id = $1 AND event = 'escalated' ORDER BY at`, [issueId])).rows;
      expect(ev.map((e) => e.details.level)).toEqual([1, 2]);
      await api(analyst).post(`/issues/${issueId}/acknowledge`).expect(200);
      t += 600 * 60_000; await evaluate();
      expect((await db.query(`SELECT count(*)::int AS n FROM alert_events WHERE issue_id = $1 AND event = 'escalated'`, [issueId])).rows[0].n).toBe(2);
    });
  });

  describe('delivery failures and recovery', () => {
    let worker: Worker<AlertJob>; let dlq: Queue;
    beforeAll(() => {
      const w = createAlertsWorker({ config: app.get<AppConfig>(CONFIG), evaluator, notifications, summaries: app.get(IssueSummaryService), enqueuer });
      worker = w.worker; dlq = w.dlq;
    });
    afterAll(async () => { await worker.close(); await dlq.close(); });

    const emailIssue = async (word: string) => {
      const r = (await rule({ name: `Mail ${word}`, ruleType: 'keyword', config: { filters: { keywords: word }, thresholds: { minMentions: 1 }, window: { minutes: 120, comparison: 'previous_windows' },
        severity: { floor: 'high' }, notify: { channels: ['in_app', 'email'], recipientUserIds: [owner.id] } } }).expect(201)).body.id;
      await mention(t - 60_000, { title: `Report mentioning ${word}`, publisher: 'pub2.example', label: 'neutral' });
      t += 5 * 60_000;
      const out = await evaluate();
      const id = out.outcomes.find((x) => x.ruleId === r)!.issueId!;
      return { id, email: (await deliveries(id)).find((x) => x.channel === 'email')! };
    };
    it('temporary SMTP failures are retried with backoff and then delivered', async () => {
      smtpMode = 'temp';
      const { email } = await emailIssue('pipeburst');
      await enqueuer.deliveries(org, [email.id], []);
      await until(async () => { const x = (await db.query('SELECT status, attempts FROM notification_deliveries WHERE id = $1', [email.id])).rows[0]; return x.status === 'failed' && x.attempts >= 1; });
      smtpMode = 'accept';
      const row = await until(async () => { const x = (await db.query('SELECT * FROM notification_deliveries WHERE id = $1', [email.id])).rows[0]; return x.status === 'delivered' && x; });
      expect(row.attempts).toBeGreaterThanOrEqual(2);
    });
    it('permanent SMTP rejection is not retried; a dead delivery can be retried manually', async () => {
      smtpMode = 'perm';
      const { email } = await emailIssue('leakage');
      await enqueuer.deliveries(org, [email.id], []);
      const row = await until(async () => { const x = (await db.query('SELECT * FROM notification_deliveries WHERE id = $1', [email.id])).rows[0]; return x.status === 'failed' && x; });
      expect(row.attempts).toBe(1);
      expect(row.last_error).toMatch(/550/);
      smtpMode = 'accept';
      await api(owner).post(`/notifications/deliveries/${email.id}/retry`).expect(202);
      await until(async () => (await db.query('SELECT status FROM notification_deliveries WHERE id = $1', [email.id])).rows[0].status === 'delivered');
      await api(analyst).get('/notifications/deliveries').expect(403);
      const log = (await api(owner).get('/notifications/deliveries').expect(200)).body;
      expect(log.channels).toMatchObject({ email: { configured: true }, whatsapp: { configured: false }, webhook: { configured: true } });
    });
    it('the scheduler (system context) finds tenants with active rules and re-queues deliveries that became due', async () => {
      const { alertsSchedulerTick } = await import('../../src/alerts/alerts-queue');
      const { Database } = await import('../../src/database/database.service');
      const deferred = (await db.query(`SELECT id FROM notification_deliveries WHERE tenant_id = $1 AND status = 'deferred' LIMIT 1`, [org])).rows[0];
      await db.query('UPDATE notification_deliveries SET not_before = $2 WHERE id = $1', [deferred.id, new Date(t - 60_000)]);   // quiet hours over (test clock)
      const r = await alertsSchedulerTick(app.get(Database), enqueuer);
      expect(r.tenants).toBeGreaterThanOrEqual(1);
      expect(r.requeued).toBeGreaterThanOrEqual(1);
      await until(async () => (await db.query('SELECT status FROM notification_deliveries WHERE id = $1', [deferred.id])).rows[0].status === 'delivered');
    });
    it('unconfigured channels are recorded as such, never as sent', async () => {
      const real = notifications.email;
      notifications.override({ email: new EmailChannel({ smtpUrl: null, from: null }) });
      try {
        const { email } = await emailIssue('sinkhole');
        expect(email).toMatchObject({ status: 'unconfigured', last_error: 'Email is not configured on this server' });
      } finally { notifications.override({ email: real }); }
    });
  });

  describe('webhooks', () => {
    let endpoint: string; let secret: string;
    let worker: Worker<AlertJob>; let dlq: Queue;
    beforeAll(() => { const w = createAlertsWorker({ config: app.get<AppConfig>(CONFIG), evaluator, notifications, summaries: app.get(IssueSummaryService), enqueuer }); worker = w.worker; dlq = w.dlq; });
    afterAll(async () => { await worker.close(); await dlq.close(); });

    it('creation returns the secret once; unverified endpoints receive nothing; verification needs the echoed challenge', async () => {
      await api(analyst).post('/webhooks', { name: 'SOC', url: hookUrl }).expect(403);
      await api(owner).post('/webhooks', { name: 'Bad', url: 'ftp://example.com/x' }).expect(400);
      const c = (await api(owner).post('/webhooks', { name: 'Ops channel', url: hookUrl, minSeverity: 'low' }).expect(201)).body;
      endpoint = c.id; secret = c.secret;
      expect(secret).toMatch(/^whsec_/);
      const list = (await api(owner).get('/webhooks').expect(200)).body;
      expect(JSON.stringify(list)).not.toContain(secret);
      expect(list[0].verified_at).toBeNull();
      hookMode = 'fail';
      await api(owner).post(`/webhooks/${endpoint}/verify`).expect(400);
      hookMode = 'ok';
      await api(owner).post(`/webhooks/${endpoint}/verify`).expect(200);
      const v = hooks.at(-1)!;
      expect(verifyWebhookSignature(String(v.headers['x-civicsignal-signature']), v.body, secret, Math.floor(t / 1000))).toBe(true);
    });
    it('delivers signed issue payloads; failures retry then dead-letter; rotation signs with both secrets', async () => {
      const r = (await rule({ name: 'Hooked', ruleType: 'keyword', config: { filters: { keywords: 'reservoir' }, thresholds: { minMentions: 1 }, window: { minutes: 120, comparison: 'previous_windows' },
        severity: { floor: 'medium' }, notify: { channels: ['in_app'], recipientUserIds: [owner.id], webhookEndpointIds: [endpoint] } } }).expect(201)).body.id;
      await mention(t - 60_000, { title: 'Reservoir level drops sharply', publisher: 'pub1.example', label: 'negative' });
      t += 5 * 60_000;
      const out = await evaluate();
      expect(out.webhookDeliveries).toHaveLength(1);
      const n = hooks.length;
      await enqueuer.deliveries(org, [], out.webhookDeliveries);
      await until(async () => (await db.query('SELECT status FROM webhook_deliveries WHERE id = $1', [out.webhookDeliveries[0]])).rows[0].status === 'delivered');
      const h = hooks[n]!;
      expect(verifyWebhookSignature(String(h.headers['x-civicsignal-signature']), h.body, secret, Math.floor(t / 1000))).toBe(true);
      const payload = JSON.parse(h.body);
      expect(payload).toMatchObject({ type: 'issue.detected', issue: { severity: 'medium', counts: { articles: 1, publishers: 1 } } });
      expect(payload.issue.sources[0].url).toMatch(/^https:\/\/pub1\.example/);
      expect(h.body).not.toMatch(/note|password|cookie/i);
      expect(h.headers['x-civicsignal-delivery']).toBe(out.webhookDeliveries[0]);
      void r;

      const rot = (await api(owner).post(`/webhooks/${endpoint}/rotate-secret`, { graceHours: 24 }).expect(200)).body;
      hookMode = 'fail';
      const r2 = (await rule({ name: 'Hooked 2', ruleType: 'keyword', config: { filters: { keywords: 'aquifer' }, thresholds: { minMentions: 1 }, window: { minutes: 120, comparison: 'previous_windows' },
        severity: { floor: 'medium' }, notify: { channels: ['in_app'], recipientUserIds: [owner.id], webhookEndpointIds: [endpoint] } } }).expect(201)).body.id;
      void r2;
      await mention(t - 60_000, { title: 'Aquifer contamination study published', publisher: 'pub3.example', label: 'neutral' });
      t += 5 * 60_000;
      const out2 = await evaluate();
      await enqueuer.deliveries(org, [], out2.webhookDeliveries);
      const dead = await until(async () => { const x = (await db.query('SELECT * FROM webhook_deliveries WHERE id = $1', [out2.webhookDeliveries[0]])).rows[0]; return x.status === 'dead' && x; });
      expect(dead).toMatchObject({ attempts: 3, response_status: 503 });
      const last = hooks.at(-1)!;
      const sig = String(last.headers['x-civicsignal-signature']);
      expect(sig.split(',').filter((p) => p.startsWith('v1='))).toHaveLength(2);
      expect(verifyWebhookSignature(sig, last.body, rot.secret, Math.floor(t / 1000))).toBe(true);
      expect(verifyWebhookSignature(sig, last.body, secret, Math.floor(t / 1000))).toBe(true);
      expect((await dlq.getJobs(['waiting'])).some((j) => j.data.job.deliveryId === out2.webhookDeliveries[0])).toBe(true);
      hookMode = 'ok';
      await api(owner).post(`/webhook-deliveries/${out2.webhookDeliveries[0]}/retry`).expect(202);
      await until(async () => (await db.query('SELECT status FROM webhook_deliveries WHERE id = $1', [out2.webhookDeliveries[0]])).rows[0].status === 'delivered');
    });
    it('webhook endpoints and deliveries are tenant-isolated', async () => {
      await http().get(`/api/v1/organizations/${otherOrg}/webhooks/${endpoint}/deliveries`).set('Cookie', outsider.cookie).expect(200).expect((x) => expect(x.body).toEqual([]));
      await http().post(`/api/v1/organizations/${otherOrg}/webhooks/${endpoint}/verify`).set('Cookie', outsider.cookie).expect(404);
      await http().delete(`/api/v1/organizations/${otherOrg}/webhooks/${endpoint}`).set('Cookie', outsider.cookie).expect(404);
    });
  });

  describe('dashboard, isolation and summaries', () => {
    it('dashboard comes from persisted issues and aggregates', async () => {
      const d = (await api(analyst).get(`/issues/dashboard?projectId=${project}`).expect(200)).body;
      expect(d.series.length).toBeGreaterThan(0);
      expect(d.series.reduce((n: number, x: { mentions: number }) => n + x.mentions, 0)).toBeGreaterThan(0);
      expect(d.counts.length).toBeGreaterThan(0);
      expect(d.freshness[0]).toHaveProperty('last_success_at');
      expect(d.lastEvaluation.status).toBe('succeeded');
      const other = (await http().get(`/api/v1/organizations/${otherOrg}/issues/dashboard`).set('Cookie', outsider.cookie).expect(200)).body;
      expect(other.counts).toEqual([]); expect(other.series).toEqual([]);
      expect((await api(unassigned).get('/issues').expect(200)).body.total).toBe(0);
    });
    it('issue summaries are extractive without a generative provider, and cite only the issue\'s records', async () => {
      const list = (await api(owner).get('/issues?limit=1').expect(200)).body.items;
      await app.get(IssueSummaryService).generate(org, list[0].id);
      const d = (await api(owner).get(`/issues/${list[0].id}`).expect(200)).body;
      expect(d.issue.ai_summary).toMatchObject({ method: 'extractive' });
      const ids = new Set(d.evidence.map((e: { id: string }) => e.id));
      for (const c of d.issue.ai_summary.claims) for (const id of c.supportingMentionIds) expect(ids.has(id)).toBe(true);
    });
    it('notification preferences are per user and validated', async () => {
      await api(analyst).put('/notifications/preferences', { items: [{ channel: 'whatsapp', enabled: true, minSeverity: 'high' }] }).expect(400);
      await api(analyst).put('/notifications/preferences', { items: [{ channel: 'whatsapp', enabled: true, minSeverity: 'high', destination: '0812' }] }).expect(400);
      await api(analyst).put('/notifications/preferences', { items: [{ channel: 'email', enabled: false, minSeverity: 'critical' }] }).expect(200);
      const p = (await api(analyst).get('/notifications/preferences').expect(200)).body;
      expect(p.items).toEqual([expect.objectContaining({ channel: 'email', enabled: false })]);
      expect(p.channels.whatsapp.configured).toBe(false);
    });
  });
});
