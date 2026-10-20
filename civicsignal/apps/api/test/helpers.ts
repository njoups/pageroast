import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApp } from '../src/app.factory';
import { APP_URL, OWNER_URL } from './env';

export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15';

export async function testApp(env: Record<string, string> = {}): Promise<INestApplication> {
  Object.assign(process.env, {
    NODE_ENV: 'test', DATABASE_URL: APP_URL, MIGRATION_DATABASE_URL: OWNER_URL,
    SCRYPT_N: '1024', RATE_LIMIT_ENABLED: 'false', APP_ORIGINS: 'http://localhost:3000',
    // Ingestion defaults per app so settings never leak between test files sharing this process.
    REDIS_URL: '', INGESTION_ALLOW_PRIVATE_HOSTS: 'false', CREDENTIALS_KEY: '', ...env,
  });
  const app = await createApp({ logger: false });
  await app.init();
  return app;
}

export interface TestUser { id: string; email: string; cookie: string }

export const uniqueEmail = (p = 'user') => `${p}-${randomBytes(4).toString('hex')}@example.test`;

export async function registerUser(app: INestApplication, name = 'Test User'): Promise<TestUser> {
  const email = uniqueEmail(name.split(' ')[0]!.toLowerCase());
  const res = await request(app.getHttpServer()).post('/api/v1/auth/register')
    .send({ email, password: 'correct horse battery', displayName: name }).expect(201);
  const cookie = (res.get('set-cookie') ?? [])[0]!.split(';')[0]!;
  return { id: res.body.user.id, email, cookie };
}

export async function createOrg(app: INestApplication, u: TestUser, name = 'Org ' + randomBytes(3).toString('hex')): Promise<string> {
  const res = await request(app.getHttpServer()).post('/api/v1/organizations').set('Cookie', u.cookie).send({ name }).expect(201);
  return res.body.id;
}

/** Invite + accept, returning a member with the given role in org. */
export async function addMember(app: INestApplication, owner: TestUser, orgId: string, role: string, name = 'Member'): Promise<TestUser> {
  const u = await registerUser(app, name);
  const inv = await request(app.getHttpServer()).post(`/api/v1/organizations/${orgId}/invitations`)
    .set('Cookie', owner.cookie).send({ email: u.email, role }).expect(201);
  await request(app.getHttpServer()).post('/api/v1/invitations/accept').set('Cookie', u.cookie).send({ token: inv.body.token }).expect(200);
  return u;
}

/**
 * Test setup only: moves an organization to another plan directly in the database (owner connection), recording the
 * change in the subscription history. Used by suites whose subject is not plan limits; plan behaviour itself is tested
 * through the platform API in commercial.e2e.ts.
 */
export async function setPlanForTest(orgId: string, planCode: string): Promise<void> {
  const { Client } = await import('pg');
  const c = new Client({ connectionString: OWNER_URL });
  await c.connect();
  try {
    await c.query(`UPDATE subscriptions s SET plan_code = p.code, plan_version_id = pv.id, status = 'active', trial_ends_at = NULL, billing_mode = 'manual'
      FROM plans p JOIN plan_versions pv ON pv.plan_id = p.id AND pv.effective_to IS NULL WHERE p.code = $2 AND s.tenant_id = $1 AND s.ended_at IS NULL`, [orgId, planCode]);
    await c.query(`INSERT INTO subscription_events (tenant_id, subscription_id, event, to_status, actor_type, reason)
      SELECT tenant_id, id, 'plan_assigned', status, 'system', 'test setup' FROM subscriptions WHERE tenant_id = $1 AND ended_at IS NULL`, [orgId]);
  } finally { await c.end(); }
}
