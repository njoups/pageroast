import { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import request from 'supertest';
import { APP_URL } from '../env';
import { addMember, createOrg, registerUser, testApp } from '../helpers';

/** Regression tests for defects found in the foundation audit (docs/IMPLEMENTATION_STATUS.md). */
describe('audit regressions (e2e)', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer());
  beforeAll(async () => { app = await testApp(); });
  afterAll(() => app.close());

  describe('user who belongs to several organizations', () => {
    it('cannot remove the last owner of org A by counting their ownership of org B', async () => {
      const sole = await registerUser(app, 'Sole Owner');
      const orgA = await createOrg(app, sole);
      await createOrg(app, sole); // also owner of a second org
      await addMember(app, sole, orgA, 'admin', 'Second Admin');
      const r = await http().patch(`/api/v1/organizations/${orgA}/members/${sole.id}`).set('Cookie', sole.cookie).send({ role: 'admin' });
      expect([r.status, r.body.error?.code]).toEqual([409, 'last_owner']);
    });

    it('team list of org A contains no rows from the caller\'s other organizations', async () => {
      const u = await registerUser(app, 'Multi Org');
      const orgA = await createOrg(app, u);
      const owner2 = await registerUser(app, 'Other Owner');
      const orgB = await createOrg(app, owner2);
      const inv = await http().post(`/api/v1/organizations/${orgB}/invitations`).set('Cookie', owner2.cookie).send({ email: u.email, role: 'analyst' }).expect(201);
      await http().post('/api/v1/invitations/accept').set('Cookie', u.cookie).send({ token: inv.body.token }).expect(200);
      const members = await http().get(`/api/v1/organizations/${orgA}/members`).set('Cookie', u.cookie).expect(200);
      expect(members.body).toHaveLength(1);
      expect(members.body[0].role).toBe('owner');
    });

    it('a role read for self-management uses the membership of the addressed org', async () => {
      // u is admin in org A and analyst in org B; as admin in A they must not be able to remove themselves
      // (admins cannot remove admins), regardless of their role elsewhere.
      const ownerA = await registerUser(app, 'Owner A');
      const orgA = await createOrg(app, ownerA);
      const u = await addMember(app, ownerA, orgA, 'admin', 'Dual Role');
      const ownerB = await registerUser(app, 'Owner B');
      const orgB = await createOrg(app, ownerB);
      const inv = await http().post(`/api/v1/organizations/${orgB}/invitations`).set('Cookie', ownerB.cookie).send({ email: u.email, role: 'analyst' }).expect(201);
      await http().post('/api/v1/invitations/accept').set('Cookie', u.cookie).send({ token: inv.body.token }).expect(200);
      await http().delete(`/api/v1/organizations/${orgA}/members/${u.id}`).set('Cookie', u.cookie).expect(403);
    });
  });

  describe('dates', () => {
    it('project date ranges round-trip unchanged regardless of server timezone', async () => {
      const u = await registerUser(app, 'Date User');
      const org = await createOrg(app, u);
      const p = await http().post(`/api/v1/organizations/${org}/projects`).set('Cookie', u.cookie)
        .send({ name: 'Dates', dateRangeStart: '2026-01-01', dateRangeEnd: '2026-01-31' }).expect(201);
      expect([p.body.date_range_start, p.body.date_range_end]).toEqual(['2026-01-01', '2026-01-31']);
      // Moving only the end date must validate against the stored start date without a timezone shift.
      await http().patch(`/api/v1/organizations/${org}/projects/${p.body.id}`).set('Cookie', u.cookie).send({ dateRangeEnd: '2026-01-01' }).expect(200);
    });
  });

  describe('database privileges of the application role', () => {
    it('cannot grant itself platform admin, even on its own row', async () => {
      const u = await registerUser(app, 'Escalator');
      const c = new Client({ connectionString: APP_URL }); await c.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.user_id', $1, true)`, [u.id]);
        await expect(c.query('UPDATE users SET is_platform_admin = true WHERE id = $1', [u.id])).rejects.toThrow(/permission denied/);
        await c.query('ROLLBACK');
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.system', 'on', true)`);
        await expect(c.query(`INSERT INTO users (email, display_name, password_hash, is_platform_admin) VALUES ('x@y.test','x','x',true)`)).rejects.toThrow(/permission denied/);
        await c.query('ROLLBACK');
      } finally { await c.end(); }
    });

    it('cannot move a membership to another tenant or user', async () => {
      const u = await registerUser(app, 'Mover');
      const org = await createOrg(app, u);
      const c = new Client({ connectionString: APP_URL }); await c.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [org]);
        await expect(c.query('UPDATE memberships SET user_id = user_id')).rejects.toThrow(/permission denied/);
        await c.query('ROLLBACK');
      } finally { await c.end(); }
    });

    it('cannot truncate the audit log', async () => {
      const c = new Client({ connectionString: APP_URL }); await c.connect();
      await expect(c.query('TRUNCATE audit_events')).rejects.toThrow(/permission denied/);
      await c.end();
    });
  });

  describe('review findings', () => {
    it('rejects non-calendar date formats with 400 instead of 500', async () => {
      const u = await registerUser(app, 'Dates Two');
      const org = await createOrg(app, u);
      const base = `/api/v1/organizations/${org}/projects`;
      for (const body of [{ name: 'W', dateRangeStart: '2026-W02-1' }, { name: 'O', dateRangeStart: '2026-02-01', dateRangeEnd: '2026-020' },
        { name: 'F', dateRangeStart: '2026-02-30' }, { name: 'T', dateRangeStart: '2026-01-10T00:00:00Z' }]) {
        const r = await http().post(base).set('Cookie', u.cookie).send(body);
        expect([body.name, r.status, r.body.error.code]).toEqual([body.name, 400, 'validation_failed']);
      }
    });

    it('report viewers cannot read project member emails', async () => {
      const owner = await registerUser(app, 'PV Owner');
      const org = await createOrg(app, owner);
      const viewer = await addMember(app, owner, org, 'report_viewer', 'Viewer');
      const p = (await http().post(`/api/v1/organizations/${org}/projects`).set('Cookie', owner.cookie).send({ name: 'Visible' }).expect(201)).body;
      await http().post(`/api/v1/organizations/${org}/projects/${p.id}/members`).set('Cookie', owner.cookie).send({ userId: viewer.id }).expect(204);
      await http().get(`/api/v1/organizations/${org}/projects/${p.id}`).set('Cookie', viewer.cookie).expect(200);
      await http().get(`/api/v1/organizations/${org}/projects/${p.id}/members`).set('Cookie', viewer.cookie).expect(403);
    });

    it('any member can leave; the last owner cannot', async () => {
      const owner = await registerUser(app, 'Leave Owner');
      const org = await createOrg(app, owner);
      const admin = await addMember(app, owner, org, 'admin', 'Leaving Admin');
      await http().post(`/api/v1/organizations/${org}/leave`).set('Cookie', admin.cookie).expect(204);
      await http().get(`/api/v1/organizations/${org}`).set('Cookie', admin.cookie).expect(404);
      const r = await http().post(`/api/v1/organizations/${org}/leave`).set('Cookie', owner.cookie).expect(409);
      expect(r.body.error.code).toBe('last_owner');
    });
  });

  describe('organization settings', () => {
    it('rejects unknown timezones and oversized values', async () => {
      const u = await registerUser(app, 'Settings');
      const org = await createOrg(app, u);
      await http().patch(`/api/v1/organizations/${org}`).set('Cookie', u.cookie).send({ settings: { timezone: 'Asia/Jakarta', locale: 'id-ID' } }).expect(200);
      await http().patch(`/api/v1/organizations/${org}`).set('Cookie', u.cookie).send({ settings: { timezone: 'Mars/Olympus' } }).expect(400);
      await http().patch(`/api/v1/organizations/${org}`).set('Cookie', u.cookie).send({ settings: { locale: 'x'.repeat(5000) } }).expect(400);
    });
  });
});

describe('login throttling per account (e2e)', () => {
  let app: INestApplication;
  beforeAll(async () => { app = await testApp({ RATE_LIMIT_ENABLED: 'true' }); });
  afterAll(async () => { await app.close(); process.env.RATE_LIMIT_ENABLED = 'false'; });

  it('locks an account after repeated failures even when the client rotates X-Forwarded-For', async () => {
    const u = await registerUser(app, 'Target');
    for (let i = 0; i < 5; i++) {
      await request(app.getHttpServer()).post('/api/v1/auth/login').set('X-Forwarded-For', `10.0.0.${i}`)
        .send({ email: u.email, password: 'wrong password ' + i }).expect(401);
    }
    const r = await request(app.getHttpServer()).post('/api/v1/auth/login').set('X-Forwarded-For', '10.0.0.99')
      .send({ email: u.email, password: 'correct horse battery' }).expect(429);
    expect(r.body.error.code).toBe('rate_limited');
  });

});

describe('login throttling: parallel burst (e2e)', () => {
  let app: INestApplication;
  beforeAll(async () => { app = await testApp({ RATE_LIMIT_ENABLED: 'true' }); });
  afterAll(async () => { await app.close(); process.env.RATE_LIMIT_ENABLED = 'false'; });

  // The per-IP limiter admits 10 of these, so at most 5 checks proves the per-account reservation works.
  it('a parallel burst cannot exceed the per-account limit', async () => {
    const u = await registerUser(app, 'Burst');
    const results = await Promise.all(Array.from({ length: 30 }, (_v, i) =>
      request(app.getHttpServer()).post('/api/v1/auth/login').set('X-Forwarded-For', `10.1.0.${i}`).send({ email: u.email, password: 'wrong ' + i })));
    const checked = results.filter((r) => r.status === 401).length;
    expect(checked).toBeLessThanOrEqual(5);
  });
});

describe('login throttling: successes only (e2e)', () => {
  let app: INestApplication;
  beforeAll(async () => { app = await testApp({ RATE_LIMIT_ENABLED: 'true' }); });
  afterAll(async () => { await app.close(); process.env.RATE_LIMIT_ENABLED = 'false'; });

  it('does not count successful logins toward the account limit', async () => {
    const u = await registerUser(app, 'Regular');
    for (let i = 0; i < 6; i++) {
      await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: u.email, password: 'correct horse battery' }).expect(200);
    }
  });
});
