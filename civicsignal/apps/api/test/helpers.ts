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
