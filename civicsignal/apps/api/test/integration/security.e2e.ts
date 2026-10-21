import { randomBytes, randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import type { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { Client } from 'pg';
import request from 'supertest';
import { EmailChannel, type EmailMessage } from '../../src/alerts/channels/email';
import { CLOCK, type Clock } from '../../src/alerts/clock';
import { AuthController } from '../../src/auth/auth.controller';
import { Database } from '../../src/database/database.service';
import { RetentionService } from '../../src/governance/retention.service';
import { ReportGenerator, SYS } from '../../src/reports/generator.service';
import { REPORTS_QUEUE } from '../../src/reports/reports-queue';
import { APP_URL, OWNER_URL } from '../env';
import { addMember, createOrg, registerUser, testApp, TEST_REDIS_URL, TestUser } from '../helpers';

/**
 * Security regression suite (Prompt 06): cross-tenant access through the API, the database, job payloads and artifact
 * downloads; privilege escalation; session expiry and revocation; password recovery; audit integrity; retention and
 * deletion; information leakage; shared rate limits. All data is synthetic; nothing leaves the test environment.
 */
const NOW = Date.UTC(2026, 9, 19, 5, 0, 0);

describe('security hardening (e2e)', () => {
  let app: INestApplication; let db: Client; let redis: IORedis; let clock: Clock;
  const http = () => request(app.getHttpServer());
  let owner: TestUser; let owner2: TestUser; let pm: TestUser; let analyst: TestUser; let outsider: TestUser;
  let A: string; let B: string; let projectA: string; let queryA: string; let sourceA: string; let sourceB: string;
  const mails: EmailMessage[] = [];
  const api = (u: TestUser, org: () => string = () => A) => ({
    get: (p: string) => http().get(`/api/v1/organizations/${org()}${p}`).set('Cookie', u.cookie),
    post: (p: string, b: object = {}) => http().post(`/api/v1/organizations/${org()}${p}`).set('Cookie', u.cookie).send(b),
    patch: (p: string, b: object = {}) => http().patch(`/api/v1/organizations/${org()}${p}`).set('Cookie', u.cookie).send(b),
    put: (p: string, b: object = {}) => http().put(`/api/v1/organizations/${org()}${p}`).set('Cookie', u.cookie).send(b),
    del: (p: string) => http().delete(`/api/v1/organizations/${org()}${p}`).set('Cookie', u.cookie),
  });
  async function mention(tenant: string, source: string, project: string | null, query: string | null, o: { title?: string; body?: string; discovered?: Date } = {}) {
    const id = randomUUID();
    await db.query(`INSERT INTO mentions (id, tenant_id, source_id, url, canonical_url, title, body, content_hash, publisher_domain, publisher, published_at, discovered_at, provenance)
      VALUES ($1,$2,$3,$4,$4,$5,$6,$7,'pub.example','pub.example',$8,$8,'{"fixture":"security.e2e synthetic"}')`,
      [id, tenant, source, `https://pub.example/a/${id}`, o.title ?? `Synthetic record ${id.slice(0, 6)}`, o.body ?? null, randomBytes(8).toString('hex'), o.discovered ?? new Date(NOW - 86_400_000)]);
    if (project) await db.query('INSERT INTO mention_matches (tenant_id, mention_id, project_id, query_id) VALUES ($1,$2,$3,$4)', [tenant, id, project, query]);
    return id;
  }

  beforeAll(async () => {
    redis = new IORedis(TEST_REDIS_URL, { maxRetriesPerRequest: null }); await redis.flushdb();
    app = await testApp({ REDIS_URL: TEST_REDIS_URL, AI_PROVIDER: 'test', CREDENTIALS_KEY: randomBytes(32).toString('base64'), SMTP_URL: 'smtp://127.0.0.1:9/?ignoreTLS=true',
      EMAIL_FROM: 'no-reply@civicsignal.test', METRICS_TOKEN: 'm'.repeat(40), APP_BASE_URL: 'https://app.civicsignal.test', ALERTS_WEBHOOK_ALLOW_HTTP: 'false' });
    clock = app.get(CLOCK); (clock as { now: () => Date }).now = () => new Date(NOW);
    app.get(AuthController).overrideMailer(new EmailChannel({ smtpUrl: 'smtp://x', from: 'no-reply@civicsignal.test' },
      { sendMail: async (m: EmailMessage) => { mails.push(m); return { messageId: 'test' }; } } as never));
    db = new Client({ connectionString: OWNER_URL }); await db.connect();
    owner = await registerUser(app, 'Owner A'); A = await createOrg(app, owner);
    owner2 = await addMember(app, owner, A, 'admin', 'Second');
    pm = await addMember(app, owner, A, 'project_manager', 'PM');
    analyst = await addMember(app, owner, A, 'analyst', 'Analyst');
    outsider = await registerUser(app, 'Outsider'); B = await createOrg(app, outsider);
    projectA = (await api(owner).post('/projects', { name: 'Secret project' }).expect(201)).body.id;
    queryA = (await api(owner).post(`/projects/${projectA}/queries`, { name: 'Query', keywords: ['banjir'] }).expect(201)).body.id;
    await api(owner).post(`/projects/${projectA}/members`, { userId: pm.id }).expect(204);
    sourceA = (await api(owner).post('/sources', { kind: 'feed', name: 'Feed A', feedUrl: 'https://a.example/rss', authorizationStatus: 'authorized', authorizationBasis: 'Synthetic test fixture' }).expect(201)).body.id;
    sourceB = (await api(outsider, () => B).post('/sources', { kind: 'feed', name: 'Feed B', feedUrl: 'https://b.example/rss', authorizationStatus: 'authorized', authorizationBasis: 'Synthetic test fixture' }).expect(201)).body.id;
  });

  afterAll(async () => {
    await app.get<Queue>(REPORTS_QUEUE).obliterate({ force: true }).catch(() => undefined);
    await app.close(); await db.end(); redis.disconnect();
  });

  describe('cross-tenant access', () => {
    let mentionA: string; let defA: string; let runA: string; let webhookA: string; let deletionA: string; let issueA: string;
    beforeAll(async () => {
      mentionA = await mention(A, sourceA, projectA, queryA, { title: 'Tenant A confidential headline' });
      defA = (await api(owner).post('/reports/definitions', { projectId: projectA, template: 'daily_briefing', name: 'A briefing' }).expect(201)).body.id;
      runA = (await api(owner).post(`/reports/definitions/${defA}/generate`, { periodStart: new Date(NOW - 3 * 86_400_000).toISOString(), periodEnd: new Date(NOW - 86_400_000).toISOString() }).expect(202)).body.id;
      expect((await app.get(ReportGenerator).generate(A, runA, true)).status).toBe('succeeded');
      webhookA = (await api(owner).post('/webhooks', { name: 'Hook', url: 'https://hooks.example/a', minSeverity: 'high' }).expect(201)).body.id;
      deletionA = (await api(owner).post('/deletion-requests', { scope: 'mentions', mentionIds: [mentionA], reason: 'Cross-tenant test fixture' }).expect(201)).body.id;
      const rule = (await api(owner).post('/alert-rules', { projectId: projectA, name: 'Rule A', ruleType: 'keyword', config: { filters: { keywords: 'banjir' } } }).expect(201)).body.id;
      issueA = (await db.query(`INSERT INTO detected_issues (tenant_id, project_id, rule_id, rule_version, scope, signal, subject_type, subject_key, dedup_key, group_key, title, severity, severity_points,
        severity_breakdown, detection, first_detected_at, last_detected_at) VALUES ($1,$2,$3,1,'issue','keyword','keyword','x','d','g','Issue A','high',60,'{}','{}',now(),now()) RETURNING id`, [A, projectA, rule])).rows[0].id;
    });

    const targets = () => [
      ['get', `/projects/${projectA}`], ['patch', `/projects/${projectA}`], ['del', `/projects/${projectA}`], ['get', `/projects/${projectA}/queries`],
      ['get', `/mentions/${mentionA}`], ['get', `/mentions/${mentionA}/analysis`], ['post', `/mentions/${mentionA}/reprocess`],
      ['get', `/sources/${sourceA}`], ['patch', `/sources/${sourceA}`], ['put', `/sources/${sourceA}/credentials`], ['get', `/sources/${sourceA}/runs`],
      ['get', `/issues/${issueA}`], ['post', `/issues/${issueA}/acknowledge`], ['post', `/issues/${issueA}/notes`],
      ['get', `/reports/definitions/${defA}`], ['post', `/reports/definitions/${defA}/generate`], ['get', `/reports/runs/${runA}`],
      ['get', `/reports/runs/${runA}/download/pdf`], ['get', `/reports/runs/${runA}/download/csv`],
      ['patch', `/webhooks/${webhookA}`], ['post', `/webhooks/${webhookA}/rotate-secret`], ['get', `/webhooks/${webhookA}/deliveries`],
      ['get', `/deletion-requests/${deletionA}`], ['post', `/deletion-requests/${deletionA}/approve`],
      ['get', '/audit-events'], ['get', '/analytics/overview'], ['get', '/data-governance'],
    ] as const;

    it('another tenant\'s member gets 404 on every org A route and never sees A data through their own org', async () => {
      for (const [m, p] of targets()) {
        const viaA = await api(outsider)[m](p);
        expect([m, p, viaA.status]).toEqual([m, p, 404]);
        const viaB = await api(outsider, () => B)[m](p);
        expect(viaB.status === 404 || viaB.status === 400 || (viaB.status === 200 && !JSON.stringify(viaB.body).includes(A))).toBe(true);
        expect(JSON.stringify(viaB.body)).not.toContain('Tenant A confidential');
      }
      // And the reverse direction: org A's owner cannot address org B's source through either org.
      await api(owner).get(`/sources/${sourceB}`).expect(404);
      await api(owner, () => B).get(`/sources/${sourceB}`).expect(404);
      void owner2;
    });

    it('the database refuses cross-tenant reads and writes on every tenant table', async () => {
      const app2 = new Client({ connectionString: APP_URL }); await app2.connect();
      try {
        const tables = (await db.query(`SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t USING (table_schema, table_name)
          WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND t.table_type = 'BASE TABLE' ORDER BY 1`)).rows.map((r) => r.table_name);
        expect(tables.length).toBeGreaterThan(50);
        await app2.query('BEGIN');
        await app2.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)`, [B, outsider.id]);
        for (const t of tables) {
          const ownerCount = (await db.query(`SELECT count(*)::int AS n FROM ${t} WHERE tenant_id = $1`, [A])).rows[0].n;
          const seen = await app2.query(`SAVEPOINT s; SELECT count(*)::int AS n FROM ${t} WHERE tenant_id = '${A}'`).then((r) => (r as unknown as Array<{ rows: Array<{ n: number }> }>)[1]!.rows[0]!.n).catch(() => 0);
          await app2.query('ROLLBACK TO SAVEPOINT s').catch(() => undefined);
          expect([t, seen]).toEqual([t, 0]);
          void ownerCount;
        }
        // A write tagged with another tenant's id is rejected by the policy's WITH CHECK.
        await expect(app2.query(`INSERT INTO projects (tenant_id, name) VALUES ($1, 'Injected')`, [A])).rejects.toThrow(/row-level security|permission denied/);
        await app2.query('ROLLBACK');
      } finally { await app2.end(); }
    });

    it('a job carrying another tenant\'s id cannot read or act on the target tenant\'s data', async () => {
      expect(await app.get(ReportGenerator).generate(B, runA, true)).toEqual({ status: 'skipped' });
      const r = await app.get(Database).withTenant(B, SYS, async (c) => ({
        mention: (await c.query('SELECT id FROM mentions WHERE id = $1', [mentionA])).rowCount,
        deleted: (await c.query('DELETE FROM mentions WHERE id = $1', [mentionA])).rowCount,
      }));
      expect(r).toEqual({ mention: 0, deleted: 0 });
      expect((await db.query('SELECT 1 FROM mentions WHERE id = $1', [mentionA])).rowCount).toBe(1);
      const run = await app.get(RetentionService).run(B, { dryRun: true, trigger: 'manual' });
      expect(run.counts.source_licence_expired).toBe(0);
    });

    it('project managers cannot manage tenant-wide integrations, and the denial is audited', async () => {
      await api(pm).get('/webhooks').expect(403);
      await api(pm).post(`/webhooks/${webhookA}/rotate-secret`, {}).expect(403);
      await api(pm).get('/notifications/deliveries').expect(403);
      const opts = (await api(pm).get('/webhooks/options').expect(200)).body;
      expect(opts[0]).toEqual({ id: webhookA, name: 'Hook', min_severity: 'high', is_active: true, verified_at: null });
      await api(pm).post('/analysis/backfill', {}).expect(403);
      const denied = (await db.query(`SELECT actor_user_id, outcome, metadata FROM audit_events WHERE tenant_id = $1 AND action = 'authz.denied' ORDER BY id`, [A])).rows;
      expect(denied.length).toBeGreaterThanOrEqual(4);
      expect(denied[0]).toMatchObject({ actor_user_id: pm.id, outcome: 'denied', metadata: { permission: 'integrations:manage', role: 'project_manager' } });
    });
  });

  describe('sessions', () => {
    it('expired, idle and revoked sessions are rejected; users can list and revoke their sessions', async () => {
      const u = await registerUser(app, 'Session User');
      await http().get('/api/v1/auth/me').set('Cookie', u.cookie).expect(200);
      const second = await http().post('/api/v1/auth/login').send({ email: u.email, password: 'correct horse battery' }).expect(200);
      const cookie2 = second.get('set-cookie')![0]!.split(';')[0]!;
      const list = (await http().get('/api/v1/auth/sessions').set('Cookie', u.cookie).expect(200)).body.sessions;
      expect(list).toHaveLength(2);
      expect(list.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
      expect(JSON.stringify(list)).not.toMatch(/token/i);
      // Idle beyond SESSION_IDLE_SECONDS (default 2 h): rejected even though the absolute expiry is hours away.
      await db.query(`UPDATE sessions SET last_seen_at = now() - interval '3 hours' WHERE user_id = $1 AND token_hash <> ''`, [u.id]);
      await http().get('/api/v1/auth/me').set('Cookie', u.cookie).expect(401);
      await db.query(`UPDATE sessions SET last_seen_at = now() WHERE user_id = $1`, [u.id]);
      await http().get('/api/v1/auth/me').set('Cookie', u.cookie).expect(200);
      const r = (await http().post('/api/v1/auth/sessions/revoke-others').set('Cookie', u.cookie).expect(200)).body;
      expect(r.revoked).toBe(1);
      await http().get('/api/v1/auth/me').set('Cookie', cookie2).expect(401);
      await db.query(`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE user_id = $1`, [u.id]);
      await http().get('/api/v1/auth/me').set('Cookie', u.cookie).expect(401);
      // Another user's session id cannot be revoked by guessing it.
      const other = (await db.query('SELECT id FROM sessions WHERE user_id = $1 LIMIT 1', [owner.id])).rows[0].id;
      const v = await registerUser(app, 'Victim Probe');
      await http().delete(`/api/v1/auth/sessions/${other}`).set('Cookie', v.cookie).expect(404);
      const audit = (await db.query(`SELECT action FROM audit_events WHERE actor_user_id = $1 ORDER BY id`, [u.id])).rows.map((x) => x.action);
      expect(audit).toContain('auth.sessions_revoked');
    });
  });

  describe('password recovery', () => {
    it('issues a single-use, expiring token by email without revealing whether the account exists', async () => {
      const u = await registerUser(app, 'Reset User');
      mails.length = 0;
      const known = await http().post('/api/v1/auth/password-reset/request').send({ email: u.email }).expect(202);
      const unknown = await http().post('/api/v1/auth/password-reset/request').send({ email: 'nobody-here@example.test' }).expect(202);
      expect(known.body).toEqual(unknown.body);
      await new Promise((r) => setTimeout(r, 50));
      expect(mails).toHaveLength(1);
      expect(mails[0]!.to).toBe(u.email);
      const token = /#token=([A-Za-z0-9_-]{43})/.exec(mails[0]!.text)![1]!;
      expect(mails[0]!.text).toContain('https://app.civicsignal.test/reset-password#token=');
      const stored = (await db.query('SELECT token_hash FROM password_reset_tokens WHERE user_id = $1', [u.id])).rows[0].token_hash;
      expect(stored).not.toContain(token);
      await http().post('/api/v1/auth/password-reset/confirm').send({ token, newPassword: 'short' }).expect(400);
      await http().post('/api/v1/auth/password-reset/confirm').send({ token, newPassword: 'a brand new passphrase' }).expect(204);
      await http().get('/api/v1/auth/me').set('Cookie', u.cookie).expect(401);                     // all sessions revoked
      await http().post('/api/v1/auth/password-reset/confirm').send({ token, newPassword: 'another new passphrase' }).expect(400);   // single use
      await http().post('/api/v1/auth/login').send({ email: u.email, password: 'a brand new passphrase' }).expect(200);
      // Expired tokens are refused.
      await http().post('/api/v1/auth/password-reset/request').send({ email: u.email }).expect(202);
      await new Promise((r) => setTimeout(r, 50));
      const t2 = /#token=([A-Za-z0-9_-]{43})/.exec(mails[1]!.text)![1]!;
      await db.query(`UPDATE password_reset_tokens SET expires_at = now() - interval '1 minute' WHERE user_id = $1 AND used_at IS NULL`, [u.id]);
      await http().post('/api/v1/auth/password-reset/confirm').send({ token: t2, newPassword: 'yet another passphrase' }).expect(400);
      const actions = (await db.query(`SELECT action, outcome FROM audit_events WHERE action LIKE 'auth.password_reset%' ORDER BY id`)).rows;
      expect(actions.map((a) => `${a.action}:${a.outcome}`)).toEqual(expect.arrayContaining(['auth.password_reset_completed:success', 'auth.password_reset_failed:failure']));
      expect(JSON.stringify(await db.query(`SELECT metadata FROM audit_events WHERE action LIKE 'auth.password_reset%'`).then((r) => r.rows))).not.toContain(token);
    });
  });

  describe('audit integrity', () => {
    it('events carry outcome and correlation id, are hash-chained per tenant, and tampering is detected', async () => {
      const app2 = new Client({ connectionString: APP_URL }); await app2.connect();
      try {
        await app2.query('BEGIN'); await app2.query(`SELECT set_config('app.tenant_id', $1, true)`, [A]);
        const v = (await app2.query(`SELECT * FROM audit_verify_chain($1)`, [A])).rows[0];
        expect(v.first_bad_id).toBeNull(); expect(Number(v.checked)).toBeGreaterThan(10);
        await expect(app2.query(`UPDATE audit_events SET action = 'x' WHERE tenant_id = $1`, [A])).rejects.toThrow(/permission denied|append-only/);
        await app2.query('ROLLBACK');
        await app2.query('BEGIN');
        await expect(app2.query('SELECT * FROM audit_chain_heads')).rejects.toThrow(/permission denied/);
        await app2.query('ROLLBACK');
      } finally { await app2.end(); }
      const row = (await db.query(`SELECT event_id, outcome, request_id, row_hash FROM audit_events WHERE tenant_id = $1 AND action = 'project.created' LIMIT 1`, [A])).rows[0];
      expect(row.event_id).toMatch(/^[0-9a-f-]{36}$/); expect(row.outcome).toBe('success'); expect(row.request_id).toBeTruthy(); expect(row.row_hash).toBeInstanceOf(Buffer);
      // An operator-level edit (trigger bypassed) breaks the chain at that row.
      const target = (await db.query(`SELECT id FROM audit_events WHERE tenant_id = $1 ORDER BY id OFFSET 2 LIMIT 1`, [A])).rows[0].id;
      await db.query('ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update');
      await db.query(`UPDATE audit_events SET metadata = '{"edited":true}' WHERE id = $1`, [target]);
      await db.query('ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update');
      expect(Number((await db.query(`SELECT first_bad_id FROM audit_verify_chain($1)`, [A])).rows[0].first_bad_id)).toBe(Number(target));
    });

    it('credential-like metadata keys are redacted before they are stored', async () => {
      await app.get(Database).withTenant(A, owner.id, (c) => app.get(AuthController)['audit'].record(c, { tenantId: A, actorUserId: owner.id, action: 'test.redaction',
        metadata: { apiKey: 'sk-should-not-appear', nested: { password: 'p', secretToken: 't' }, count: 3 } }));
      const m = (await db.query(`SELECT metadata FROM audit_events WHERE action = 'test.redaction'`)).rows[0].metadata;
      expect(m).toEqual({ apiKey: '[redacted]', nested: { password: '[redacted]', secretToken: '[redacted]' }, count: 3 });
    });
  });

  describe('retention and deletion', () => {
    let C: string; let ownerC: TestUser; let ownerC2: TestUser; let project: string; let query: string; let source: string;
    beforeAll(async () => {
      ownerC = await registerUser(app, 'Retention Owner'); C = await createOrg(app, ownerC);
      ownerC2 = await addMember(app, ownerC, C, 'admin', 'Retention Admin');
      await db.query(`UPDATE memberships SET role = 'owner' WHERE tenant_id = $1 AND user_id = $2`, [C, ownerC2.id]);
      project = (await api(ownerC, () => C).post('/projects', { name: 'Retained' }).expect(201)).body.id;
      query = (await api(ownerC, () => C).post(`/projects/${project}/queries`, { name: 'Query', keywords: ['banjir'] }).expect(201)).body.id;
      source = (await api(ownerC, () => C).post('/sources', { kind: 'feed', name: 'Feed C', feedUrl: 'https://c.example/rss', authorizationStatus: 'authorized', authorizationBasis: 'Synthetic test fixture' }).expect(201)).body.id;
    });

    it('does nothing until enabled, previews exactly, honours legal hold, and deletes old records with derived data', async () => {
      const old1 = await mention(C, source, project, query, { discovered: new Date(NOW - 400 * 86_400_000), body: 'full text' });
      const old2 = await mention(C, source, project, query, { discovered: new Date(NOW - 380 * 86_400_000) });
      const recent = await mention(C, source, project, query, { discovered: new Date(NOW - 5 * 86_400_000), body: 'recent body' });
      const licence = await mention(C, source, project, query, { discovered: new Date(NOW - 10 * 86_400_000) });
      await db.query('UPDATE mentions SET retention_expires_at = $2 WHERE id = $1', [licence, new Date(NOW - 86_400_000)]);
      const api3 = api(ownerC, () => C);
      await api3.put('/data-governance/retention-policies/mention_metadata', { retentionDays: 365 }).expect(200);
      await api3.put('/data-governance/retention-policies/audit_events', { retentionDays: 30 }).expect(400);
      // Not enabled: an apply request is recorded as skipped and deletes nothing.
      const skipped = (await api3.post('/data-governance/retention/apply').expect(200)).body;
      expect(skipped).toMatchObject({ status: 'skipped', skippedReason: 'retention_disabled', counts: { mentions_deleted: 2, source_licence_expired: 1 } });
      expect((await db.query('SELECT count(*)::int AS n FROM mentions WHERE tenant_id = $1', [C])).rows[0].n).toBe(4);
      await api3.put('/data-governance/controls', { retentionEnabled: true, legalHold: true, legalHoldReason: 'Litigation hold (test)' }).expect(200);
      expect((await api3.post('/data-governance/retention/apply').expect(200)).body).toMatchObject({ status: 'skipped', skippedReason: 'legal_hold' });
      expect((await api3.post('/deletion-requests', { scope: 'mentions', mentionIds: [recent], reason: 'Should be blocked' })).status).toBe(409);
      await api3.put('/data-governance/controls', { legalHold: false }).expect(200);
      await db.query(`INSERT INTO analytics_cache (tenant_id, cache_key, metric, data_version, payload, expires_at) VALUES ($1, 'k', 'm', 0, '{}', now() + interval '1 hour')`, [C]);
      const applied = (await api3.post('/data-governance/retention/apply').expect(200)).body;
      expect(applied).toMatchObject({ status: 'succeeded', counts: { mentions_deleted: 2, source_licence_expired: 1 } });
      const left = (await db.query('SELECT id FROM mentions WHERE tenant_id = $1', [C])).rows.map((r) => r.id);
      expect(left).toEqual([recent]);
      expect((await db.query('SELECT count(*)::int AS n FROM mention_matches WHERE mention_id = ANY($1::uuid[])', [[old1, old2, licence]])).rows[0].n).toBe(0);
      expect((await db.query('SELECT count(*)::int AS n FROM analytics_cache WHERE tenant_id = $1', [C])).rows[0].n).toBe(0);
      const audit = (await db.query(`SELECT action FROM audit_events WHERE tenant_id = $1 AND action LIKE 'retention.%' OR (tenant_id = $1 AND action = 'data_controls.updated') ORDER BY id`, [C])).rows.map((r) => r.action);
      expect(audit).toEqual(expect.arrayContaining(['retention.policy_set', 'retention.skipped', 'data_controls.updated', 'retention.applied']));
      await api(analyst).post('/data-governance/retention/apply').expect(403);
    });

    it('deletion requests: preview, four-eyes approval, purge of derived artifacts, audit', async () => {
      const api3 = api(ownerC, () => C);
      const target = await mention(C, source, project, query, { title: 'Budi Santoso named in coverage', body: 'mentions Budi Santoso' });
      const other = await mention(C, source, project, query, { title: 'Unrelated coverage' });
      const def = (await api3.post('/reports/definitions', { projectId: project, template: 'daily_briefing', name: 'C briefing' }).expect(201)).body.id;
      const run = (await api3.post(`/reports/definitions/${def}/generate`, { periodStart: new Date(NOW - 3 * 86_400_000).toISOString(), periodEnd: new Date(NOW).toISOString() }).expect(202)).body.id;
      expect((await app.get(ReportGenerator).generate(C, run, true)).status).toBe('succeeded');
      expect((await db.query('SELECT count(*)::int AS n FROM report_run_sources WHERE run_id = $1 AND mention_id = $2', [run, target])).rows[0].n).toBeGreaterThan(0);
      const req = (await api3.post('/deletion-requests', { scope: 'search', query: 'Budi Santoso', reason: 'Data subject erasure request #42' }).expect(201)).body;
      expect(req.preview).toMatchObject({ mentions: 1, report_runs_citing: 1 });
      expect(req.preview.sample[0].id).toBe(target);
      await api3.post(`/deletion-requests/${req.id}/approve`, {}).expect(403);                                  // requester cannot approve (two owners)
      await api(ownerC2, () => C).post(`/deletion-requests/${req.id}/approve`, { note: 'Verified identity' }).expect(200);
      expect((await db.query('SELECT id FROM mentions WHERE id = ANY($1::uuid[])', [[target, other]])).rows.map((r) => r.id)).toEqual([other]);
      const art = (await db.query('SELECT data IS NULL AS gone, expired_at FROM report_artifacts WHERE run_id = $1', [run])).rows;
      expect(art.every((a) => a.gone && a.expired_at)).toBe(true);
      await api3.get(`/reports/runs/${run}/download/pdf`).expect(410);
      const d = (await api3.get(`/deletion-requests/${req.id}`).expect(200)).body;
      expect(d).toMatchObject({ status: 'completed', result: { mentions: 1, report_artifacts_expired: 2 } });
      expect(JSON.stringify(d)).not.toContain('resolvedMentionIds');
      await api3.post(`/deletion-requests/${req.id}/approve`, {}).expect(409);
      const audit = (await db.query(`SELECT action, actor_user_id FROM audit_events WHERE tenant_id = $1 AND action LIKE 'deletion.%' ORDER BY id`, [C])).rows;
      expect(audit.map((a) => a.action)).toEqual(['deletion.requested', 'deletion.completed']);
      expect(audit[1].actor_user_id).toBe(ownerC2.id);
    });
  });

  describe('information leakage and limits', () => {
    it('health endpoints disclose status words only; metrics need the token', async () => {
      const ready = (await http().get('/health/ready').expect(200)).body;
      expect(ready).toEqual({ status: 'ok', checks: { database: 'up', redis: 'up', migrations: 'current' } });
      await http().get('/metrics').expect(401);
      await http().get('/metrics').set('Authorization', 'Bearer wrong').expect(401);
      const m = await http().get('/metrics').set('Authorization', `Bearer ${'m'.repeat(40)}`).expect(200);
      expect(m.text).toContain('civicsignal_http_requests_total');
      expect(m.text).toContain('civicsignal_queue_jobs');
      // P10 operational gauges: pool saturation, collection, billing webhooks, social quota (aggregates, never per tenant).
      expect(m.text).toMatch(/civicsignal_db_pool_connections\{state="max"\} \d+/);
      for (const g of ['civicsignal_ingestion_runs_last_hour', 'civicsignal_billing_webhook_failures_last_hour', 'civicsignal_social_quota_events_last_day']) expect(m.text).toContain(`# TYPE ${g} gauge`);
      expect(m.text).not.toMatch(/tenant(_id)?="/);
      expect(m.text).not.toContain(A); expect(m.text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    });

    it('errors never include stack traces or SQL; malformed payloads are rejected', async () => {
      const r = await api(owner).get('/mentions/not-a-uuid');
      expect(r.status).toBeGreaterThanOrEqual(400); expect(r.status).toBeLessThan(500);
      expect(JSON.stringify(r.body)).not.toMatch(/at \w+ \(|SELECT|stack/i);
      await api(owner).post('/projects', { name: 'X1', isAdmin: true }).expect(400);
      await http().post('/api/v1/auth/login').set('Content-Type', 'application/json').send('{"email": ').expect(400);
      await http().post('/api/v1/auth/login').send({ email: 'a@b.test', password: 'x'.repeat(200_000) }).expect(413);
      await api(owner).post('/deletion-requests', { scope: 'search', query: 'x', reason: 'too short query' }).expect(400);
    });

    it('rate limits are shared across API instances through Redis', async () => {
      const a1 = await testApp({ REDIS_URL: TEST_REDIS_URL, RATE_LIMIT_ENABLED: 'true' });
      const a2 = await testApp({ REDIS_URL: TEST_REDIS_URL, RATE_LIMIT_ENABLED: 'true' });
      try {
        const email = `nobody-${randomBytes(3).toString('hex')}@example.test`;
        const codes: number[] = [];
        for (let i = 0; i < 6; i++) codes.push((await request((i % 2 ? a2 : a1).getHttpServer()).post('/api/v1/auth/login').send({ email, password: 'wrong password!' })).status);
        expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
        expect(codes[5]).toBe(429);                          // the 6th attempt, split across two instances, is refused
      } finally { await a1.close(); await a2.close(); }
    });
  });
});
