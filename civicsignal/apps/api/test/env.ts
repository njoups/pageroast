export const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://postgres@localhost:5433/postgres';
export const TEST_DB = 'civicsignal_test';
export const APP_PASSWORD = 'test-app-password';
const u = new URL(ADMIN_URL);
export const OWNER_URL = `${u.protocol}//${u.username}${u.password ? ':' + u.password : ''}@${u.host}/${TEST_DB}`;
export const APP_URL = `${u.protocol}//civicsignal_app:${APP_PASSWORD}@${u.host}/${TEST_DB}`;
