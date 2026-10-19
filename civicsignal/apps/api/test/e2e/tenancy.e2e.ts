import { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import request from 'supertest';
import { OWNER_URL } from '../env';
import { addMember, createOrg, registerUser, testApp, TestUser } from '../helpers';

describe('organizations, roles, projects and tenant isolation (e2e)', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer());
  let alice: TestUser; let bob: TestUser; let orgA: string; let orgB: string; let projectB: string;

  beforeAll(async () => {
    app = await testApp();
    alice = await registerUser(app, 'Alice Owner');
    bob = await registerUser(app, 'Bob Owner');
    orgA = await createOrg(app, alice, 'Kementerian A');
    orgB = await createOrg(app, bob, 'Agency B');
    projectB = (await http().post(`/api/v1/organizations/${orgB}/projects`).set('Cookie', bob.cookie).send({ name: 'Secret B' }).expect(201)).body.id;
  });
  afterAll(() => app.close());

  describe('cross-tenant isolation over HTTP', () => {
    const routes = (org: string, project: string): Array<[string, string, object?]> => [
      ['get', `/api/v1/organizations/${org}`],
      ['patch', `/api/v1/organizations/${org}`, { name: 'Hijacked' }],
      ['get', `/api/v1/organizations/${org}/members`],
      ['get', `/api/v1/organizations/${org}/projects`],
      ['get', `/api/v1/organizations/${org}/projects/${project}`],
      ['patch', `/api/v1/organizations/${org}/projects/${project}`, { name: 'Hijacked' }],
      ['delete', `/api/v1/organizations/${org}/projects/${project}`],
      ['post', `/api/v1/organizations/${org}/invitations`, { email: 'x@example.test', role: 'analyst' }],
      ['get', `/api/v1/organizations/${org}/audit-events`],
    ];

    it('a member of org A gets 404 on every org B route', async () => {
      for (const [method, url, body] of routes(orgB, projectB)) {
        const r = await (http() as unknown as Record<string, (u: string) => request.Test>)[method]!(url).set('Cookie', alice.cookie).send(body);
        expect([url, r.status]).toEqual([url, 404]);
      }
    });

    it('org A project routes cannot reach an org B project id', async () => {
      await http().get(`/api/v1/organizations/${orgA}/projects/${projectB}`).set('Cookie', alice.cookie).expect(404);
      await http().delete(`/api/v1/organizations/${orgA}/projects/${projectB}`).set('Cookie', alice.cookie).expect(404);
      await http().get(`/api/v1/organizations/${orgB}/projects/${projectB}`).set('Cookie', bob.cookie).expect(200);
    });

    it('unauthenticated requests get 401; malformed org ids 404', async () => {
      await http().get(`/api/v1/organizations/${orgA}/projects`).expect(401);
      await http().get(`/api/v1/organizations/not-a-uuid/projects`).set('Cookie', alice.cookie).expect(404);
    });

    it('/me lists only the caller\'s organizations', async () => {
      const me = await http().get('/api/v1/auth/me').set('Cookie', alice.cookie).expect(200);
      expect(me.body.organizations.map((o: { id: string }) => o.id)).toEqual([orgA]);
    });

    it('audit log never shows another tenant\'s events', async () => {
      const r = await http().get(`/api/v1/organizations/${orgA}/audit-events?limit=200`).set('Cookie', alice.cookie).expect(200);
      expect(r.body.items.length).toBeGreaterThan(0);
      expect(r.body.items.some((e: { target_id: string }) => e.target_id === projectB || e.target_id === orgB)).toBe(false);
    });
  });

  describe('platform administrator', () => {
    let admin: TestUser;
    beforeAll(async () => {
      admin = await registerUser(app, 'Platform Admin');
      const c = new Client({ connectionString: OWNER_URL }); await c.connect();
      await c.query('UPDATE users SET is_platform_admin = true WHERE id = $1', [admin.id]); await c.end();
    });

    it('has no implicit access to tenant content', async () => {
      await http().get(`/api/v1/organizations/${orgB}/projects`).set('Cookie', admin.cookie).expect(404);
      await http().get(`/api/v1/organizations/${orgB}/audit-events`).set('Cookie', admin.cookie).expect(404);
    });

    it('can list tenant metadata, and that access is audited', async () => {
      const r = await http().get('/api/v1/platform/tenants').set('Cookie', admin.cookie).expect(200);
      expect(r.body.map((t: { id: string }) => t.id)).toEqual(expect.arrayContaining([orgA, orgB]));
      expect(Object.keys(r.body[0]).sort()).toEqual(['archived_at', 'created_at', 'id', 'member_count', 'name', 'slug']);
      const c = new Client({ connectionString: OWNER_URL }); await c.connect();
      const a = await c.query(`SELECT 1 FROM audit_events WHERE action = 'platform.tenants_listed' AND actor_user_id = $1`, [admin.id]);
      await c.end();
      expect(a.rowCount).toBe(1);
    });

    it('regular users cannot use platform endpoints', async () => {
      await http().get('/api/v1/platform/tenants').set('Cookie', alice.cookie).expect(403);
    });
  });

  describe('roles and membership', () => {
    let admin: TestUser; let pm: TestUser; let analyst: TestUser; let viewer: TestUser;
    beforeAll(async () => {
      admin = await addMember(app, alice, orgA, 'admin', 'Adi Admin');
      pm = await addMember(app, alice, orgA, 'project_manager', 'Putri PM');
      analyst = await addMember(app, alice, orgA, 'analyst', 'Andi Analyst');
      viewer = await addMember(app, alice, orgA, 'report_viewer', 'Vera Viewer');
    });

    it('lists members with roles', async () => {
      const r = await http().get(`/api/v1/organizations/${orgA}/members`).set('Cookie', admin.cookie).expect(200);
      expect(r.body.map((m: { role: string }) => m.role).sort()).toEqual(['admin', 'analyst', 'owner', 'project_manager', 'report_viewer']);
    });

    it('enforces the permission matrix over HTTP', async () => {
      await http().post(`/api/v1/organizations/${orgA}/projects`).set('Cookie', analyst.cookie).send({ name: 'Nope' }).expect(403);
      await http().get(`/api/v1/organizations/${orgA}/members`).set('Cookie', viewer.cookie).expect(403);
      await http().get(`/api/v1/organizations/${orgA}/audit-events`).set('Cookie', pm.cookie).expect(403);
      await http().post(`/api/v1/organizations/${orgA}/invitations`).set('Cookie', pm.cookie).send({ email: 'z@example.test', role: 'analyst' }).expect(403);
    });

    it('admins cannot escalate to admin/owner or touch owners', async () => {
      await http().patch(`/api/v1/organizations/${orgA}/members/${analyst.id}`).set('Cookie', admin.cookie).send({ role: 'admin' }).expect(403);
      await http().patch(`/api/v1/organizations/${orgA}/members/${alice.id}`).set('Cookie', admin.cookie).send({ role: 'analyst' }).expect(403);
      await http().patch(`/api/v1/organizations/${orgA}/members/${admin.id}`).set('Cookie', admin.cookie).send({ role: 'owner' }).expect(403);
      await http().post(`/api/v1/organizations/${orgA}/invitations`).set('Cookie', admin.cookie).send({ email: 'adm@example.test', role: 'admin' }).expect(403);
      await http().patch(`/api/v1/organizations/${orgA}/members/${analyst.id}`).set('Cookie', admin.cookie).send({ role: 'project_manager' }).expect(200);
      await http().patch(`/api/v1/organizations/${orgA}/members/${analyst.id}`).set('Cookie', admin.cookie).send({ role: 'analyst' }).expect(200);
    });

    it('the last owner cannot be demoted or removed', async () => {
      const r = await http().patch(`/api/v1/organizations/${orgA}/members/${alice.id}`).set('Cookie', alice.cookie).send({ role: 'admin' }).expect(409);
      expect(r.body.error.code).toBe('last_owner');
      await http().delete(`/api/v1/organizations/${orgA}/members/${alice.id}`).set('Cookie', alice.cookie).expect(409);
    });

    it('rejects unknown roles', async () => {
      await http().patch(`/api/v1/organizations/${orgA}/members/${analyst.id}`).set('Cookie', alice.cookie).send({ role: 'superuser' }).expect(400);
    });

    it('project visibility: non-admins only see assigned projects', async () => {
      const p = (await http().post(`/api/v1/organizations/${orgA}/projects`).set('Cookie', alice.cookie).send({ name: 'Program Bansos', languages: ['id'] }).expect(201)).body;
      await http().get(`/api/v1/organizations/${orgA}/projects/${p.id}`).set('Cookie', analyst.cookie).expect(404);
      let list = await http().get(`/api/v1/organizations/${orgA}/projects`).set('Cookie', viewer.cookie).expect(200);
      expect(list.body).toEqual([]);
      await http().post(`/api/v1/organizations/${orgA}/projects/${p.id}/members`).set('Cookie', pm.cookie).send({ userId: viewer.id }).expect(404); // pm not assigned
      await http().post(`/api/v1/organizations/${orgA}/projects/${p.id}/members`).set('Cookie', alice.cookie).send({ userId: viewer.id }).expect(204);
      list = await http().get(`/api/v1/organizations/${orgA}/projects`).set('Cookie', viewer.cookie).expect(200);
      expect(list.body.map((x: { id: string }) => x.id)).toEqual([p.id]);
      await http().patch(`/api/v1/organizations/${orgA}/projects/${p.id}`).set('Cookie', viewer.cookie).send({ name: 'x y' }).expect(403);
      // A user from another tenant cannot be assigned
      await http().post(`/api/v1/organizations/${orgA}/projects/${p.id}/members`).set('Cookie', alice.cookie).send({ userId: bob.id }).expect(404);
    });

    it('project managers see the projects they create', async () => {
      const p = (await http().post(`/api/v1/organizations/${orgA}/projects`).set('Cookie', pm.cookie).send({ name: 'PM Project' }).expect(201)).body;
      await http().get(`/api/v1/organizations/${orgA}/projects/${p.id}`).set('Cookie', pm.cookie).expect(200);
      await http().delete(`/api/v1/organizations/${orgA}/projects/${p.id}`).set('Cookie', pm.cookie).expect(403);
    });

    it('removing a member revokes access immediately', async () => {
      const temp = await addMember(app, alice, orgA, 'analyst', 'Temp Analyst');
      await http().get(`/api/v1/organizations/${orgA}`).set('Cookie', temp.cookie).expect(200);
      await http().delete(`/api/v1/organizations/${orgA}/members/${temp.id}`).set('Cookie', admin.cookie).expect(204);
      await http().get(`/api/v1/organizations/${orgA}`).set('Cookie', temp.cookie).expect(404);
    });
  });

  describe('invitations', () => {
    it('only the invited email can redeem, exactly once', async () => {
      const invitee = await registerUser(app, 'Invitee');
      const stranger = await registerUser(app, 'Stranger');
      const inv = await http().post(`/api/v1/organizations/${orgA}/invitations`).set('Cookie', alice.cookie).send({ email: invitee.email, role: 'analyst' }).expect(201);
      expect(inv.body.delivery).toBe('manual');
      const list = await http().get(`/api/v1/organizations/${orgA}/invitations`).set('Cookie', alice.cookie).expect(200);
      expect(list.body.find((i: { id: string }) => i.id === inv.body.id).token).toBeUndefined();
      await http().post('/api/v1/invitations/accept').set('Cookie', stranger.cookie).send({ token: inv.body.token }).expect(404);
      await http().post(`/api/v1/organizations/${orgA}/invitations`).set('Cookie', alice.cookie).send({ email: invitee.email, role: 'analyst' }).expect(409);
      const ok = await http().post('/api/v1/invitations/accept').set('Cookie', invitee.cookie).send({ token: inv.body.token }).expect(200);
      expect(ok.body).toEqual({ organizationId: orgA, role: 'analyst' });
      await http().post('/api/v1/invitations/accept').set('Cookie', invitee.cookie).send({ token: inv.body.token }).expect(404);
    });

    it('revoked invitations cannot be redeemed', async () => {
      const invitee = await registerUser(app, 'Late');
      const inv = await http().post(`/api/v1/organizations/${orgA}/invitations`).set('Cookie', alice.cookie).send({ email: invitee.email, role: 'report_viewer' }).expect(201);
      await http().delete(`/api/v1/organizations/${orgA}/invitations/${inv.body.id}`).set('Cookie', alice.cookie).expect(204);
      await http().post('/api/v1/invitations/accept').set('Cookie', invitee.cookie).send({ token: inv.body.token }).expect(404);
    });
  });

  describe('project lifecycle', () => {
    it('create → update → archive (read-only) → unarchive → delete, all audited', async () => {
      const base = `/api/v1/organizations/${orgA}/projects`;
      const p = (await http().post(base).set('Cookie', alice.cookie).send({
        name: 'Pemilu Monitoring', objective: 'Track coverage', languages: ['id', 'en'], dateRangeStart: '2026-01-01', dateRangeEnd: '2026-12-31',
      }).expect(201)).body;
      expect(p).toMatchObject({ name: 'Pemilu Monitoring', status: 'active', languages: ['id', 'en'] });
      await http().post(base).set('Cookie', alice.cookie).send({ name: 'pemilu monitoring' }).expect(409);
      await http().patch(`${base}/${p.id}`).set('Cookie', alice.cookie).send({ dateRangeEnd: '2025-01-01' }).expect(400);
      const u = await http().patch(`${base}/${p.id}`).set('Cookie', alice.cookie).send({ objective: 'Updated' }).expect(200);
      expect(u.body.objective).toBe('Updated');
      await http().post(`${base}/${p.id}/archive`).set('Cookie', alice.cookie).expect(200);
      await http().patch(`${base}/${p.id}`).set('Cookie', alice.cookie).send({ objective: 'x' }).expect(409);
      const active = await http().get(base).set('Cookie', alice.cookie).expect(200);
      expect(active.body.some((x: { id: string }) => x.id === p.id)).toBe(false);
      const archived = await http().get(`${base}?status=archived`).set('Cookie', alice.cookie).expect(200);
      expect(archived.body.some((x: { id: string }) => x.id === p.id)).toBe(true);
      await http().post(`${base}/${p.id}/unarchive`).set('Cookie', alice.cookie).expect(200);
      await http().delete(`${base}/${p.id}`).set('Cookie', alice.cookie).expect(204);
      await http().get(`${base}/${p.id}`).set('Cookie', alice.cookie).expect(404);

      const audit = await http().get(`/api/v1/organizations/${orgA}/audit-events?action=project.&limit=200`).set('Cookie', alice.cookie).expect(200);
      const actions = audit.body.items.filter((e: { target_id: string }) => e.target_id === p.id).map((e: { action: string }) => e.action);
      expect(actions).toEqual(['project.deleted', 'project.unarchived', 'project.archived', 'project.updated', 'project.created']);
    });

    it('rejects unknown fields and invalid languages', async () => {
      await http().post(`/api/v1/organizations/${orgA}/projects`).set('Cookie', alice.cookie).send({ name: 'Valid', tenant_id: orgB }).expect(400);
      await http().post(`/api/v1/organizations/${orgA}/projects`).set('Cookie', alice.cookie).send({ name: 'Valid', languages: ['indonesian'] }).expect(400);
    });

    it('audit pagination works', async () => {
      const first = await http().get(`/api/v1/organizations/${orgA}/audit-events?limit=2`).set('Cookie', alice.cookie).expect(200);
      expect(first.body.items).toHaveLength(2);
      const next = await http().get(`/api/v1/organizations/${orgA}/audit-events?limit=2&before=${first.body.nextBefore}`).set('Cookie', alice.cookie).expect(200);
      expect(Number(next.body.items[0].id)).toBeLessThan(first.body.nextBefore + 0.5);
    });

    it('org settings accept only whitelisted keys', async () => {
      await http().patch(`/api/v1/organizations/${orgA}`).set('Cookie', alice.cookie).send({ settings: { brandColor: '#0a3d62', locale: 'id-ID' } }).expect(200);
      await http().patch(`/api/v1/organizations/${orgA}`).set('Cookie', alice.cookie).send({ settings: { isPlatformAdmin: true } }).expect(400);
      await http().patch(`/api/v1/organizations/${orgA}`).set('Cookie', alice.cookie).send({ settings: { brandColor: 'red;}' } }).expect(400);
    });
  });
});
