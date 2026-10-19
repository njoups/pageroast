import { Client } from 'pg';
import { migrate } from '../src/database/migrate';
import { ADMIN_URL, APP_PASSWORD, OWNER_URL, TEST_DB } from './env';

export default async function globalSetup(): Promise<void> {
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();
  await migrate({ connectionString: OWNER_URL, appRolePassword: APP_PASSWORD });
}
