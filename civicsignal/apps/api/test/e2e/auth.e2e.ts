import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { registerUser, testApp, uniqueEmail } from '../helpers';

describe('auth (e2e)', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer());
  beforeAll(async () => { app = await testApp(); });
  afterAll(() => app.close());

  it('registers, sets a hardened session cookie, and resolves /me', async () => {
    const email = uniqueEmail();
    const res = await http().post('/api/v1/auth/register').send({ email: email.toUpperCase(), password: 'correct horse battery', displayName: ' Ana ' }).expect(201);
    expect(res.body.user).toMatchObject({ email, displayName: 'Ana', isPlatformAdmin: false });
    expect(res.body.user.password_hash).toBeUndefined();
    const raw = res.get('set-cookie')![0]!;
    expect(raw).toMatch(/cs_session=[A-Za-z0-9_-]{43}/);
    expect(raw).toMatch(/HttpOnly/);
    expect(raw).toMatch(/SameSite=Lax/);
    const me = await http().get('/api/v1/auth/me').set('Cookie', raw.split(';')[0]!).expect(200);
    expect(me.body.user.email).toBe(email);
    expect(me.body.organizations).toEqual([]);
    expect(me.body.identityProvider).toEqual({ name: 'local', mfa: false, passwordRecovery: false });
  });

  it('rejects duplicate registration with 409', async () => {
    const u = await registerUser(app);
    const res = await http().post('/api/v1/auth/register').send({ email: u.email, password: 'another long password', displayName: 'X' }).expect(409);
    expect(res.body.error.code).toBe('email_taken');
  });

  it('validates input with a consistent error envelope', async () => {
    const res = await http().post('/api/v1/auth/register').send({ email: 'nope', password: 'short', displayName: '', extra: 1 }).expect(400);
    expect(res.body.error.code).toBe('validation_failed');
    expect(res.body.error.requestId).toEqual(expect.any(String));
    const fields = res.body.error.details.map((d: { field: string }) => d.field).sort();
    expect(fields).toEqual(['displayName', 'email', 'extra', 'password']);
  });

  it('gives identical errors for unknown email and wrong password', async () => {
    const u = await registerUser(app);
    const a = await http().post('/api/v1/auth/login').send({ email: u.email, password: 'wrong password!!' }).expect(401);
    const b = await http().post('/api/v1/auth/login').send({ email: uniqueEmail('ghost'), password: 'wrong password!!' }).expect(401);
    expect(a.body.error.code).toBe('invalid_credentials');
    expect({ ...a.body.error, requestId: 0 }).toEqual({ ...b.body.error, requestId: 0 });
  });

  it('logout revokes the session server-side', async () => {
    const u = await registerUser(app);
    await http().post('/api/v1/auth/logout').set('Cookie', u.cookie).expect(204);
    await http().get('/api/v1/auth/me').set('Cookie', u.cookie).expect(401);
  });

  it('rejects forged / malformed session tokens', async () => {
    await http().get('/api/v1/auth/me').set('Cookie', 'cs_session=' + 'A'.repeat(43)).expect(401);
    await http().get('/api/v1/auth/me').set('Cookie', "cs_session=' OR 1=1 --").expect(401);
    await http().get('/api/v1/auth/me').expect(401);
  });

  it('password change revokes other sessions but keeps the current one', async () => {
    const u = await registerUser(app);
    const login = await http().post('/api/v1/auth/login').send({ email: u.email, password: 'correct horse battery' }).expect(200);
    const other = login.get('set-cookie')![0]!.split(';')[0]!;
    await http().post('/api/v1/auth/change-password').set('Cookie', u.cookie)
      .send({ currentPassword: 'wrong', newPassword: 'a brand new passphrase' }).expect(400);
    await http().post('/api/v1/auth/change-password').set('Cookie', u.cookie)
      .send({ currentPassword: 'correct horse battery', newPassword: 'a brand new passphrase' }).expect(204);
    await http().get('/api/v1/auth/me').set('Cookie', other).expect(401);
    await http().get('/api/v1/auth/me').set('Cookie', u.cookie).expect(200);
    await http().post('/api/v1/auth/login').send({ email: u.email, password: 'a brand new passphrase' }).expect(200);
  });

  it('rejects cross-origin mutating requests (CSRF)', async () => {
    const u = await registerUser(app);
    const r = await http().post('/api/v1/organizations').set('Cookie', u.cookie).set('Origin', 'https://evil.example').send({ name: 'Evil' }).expect(403);
    expect(r.body.error.code).toBe('csrf_rejected');
    await http().post('/api/v1/organizations').set('Cookie', u.cookie).set('Sec-Fetch-Site', 'cross-site').send({ name: 'Evil' }).expect(403);
    await http().post('/api/v1/organizations').set('Cookie', u.cookie).set('Origin', 'http://localhost:3000').send({ name: 'Good Org' }).expect(201);
  });

  it('does not parse form-encoded bodies', async () => {
    const u = await registerUser(app);
    const r = await http().post('/api/v1/auth/login').type('form').send({ email: u.email, password: 'correct horse battery' }).expect(400);
    expect(r.body.error.code).toBe('validation_failed');
  });

  it('serves health and OpenAPI docs', async () => {
    await http().get('/health/live').expect(200, { status: 'ok' });
    await http().get('/health/ready').expect(200);
    const doc = await http().get('/api/docs-json').expect(200);
    expect(Object.keys(doc.body.paths)).toEqual(expect.arrayContaining(['/api/v1/auth/login', '/api/v1/organizations/{orgId}/projects']));
  });
});

describe('auth rate limiting (e2e)', () => {
  let app: INestApplication;
  beforeAll(async () => { app = await testApp({ RATE_LIMIT_ENABLED: 'true' }); });
  afterAll(async () => { await app.close(); process.env.RATE_LIMIT_ENABLED = 'false'; });

  it('returns 429 after 10 login attempts in the window', async () => {
    // Distinct emails so this exercises the per-IP limit, not the per-account failure limit.
    const body = () => ({ email: uniqueEmail('rl'), password: 'whatever-password' });
    for (let i = 0; i < 10; i++) await request(app.getHttpServer()).post('/api/v1/auth/login').send(body()).expect(401);
    const r = await request(app.getHttpServer()).post('/api/v1/auth/login').send(body()).expect(429);
    expect(r.body.error.code).toBe('rate_limited');
    expect(r.body.error.details.retryAfterSeconds).toBeGreaterThan(0);
  });
});
