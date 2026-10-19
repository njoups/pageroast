import { cpSync, mkdtempSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { migrate, MIGRATIONS_DIR } from '../../src/database/migrate';
import { OWNER_URL } from '../env';

const REQUIRED = ['tenants', 'users', 'memberships', 'projects', 'project_members', 'monitoring_queries', 'sources', 'connectors',
  'connector_runs', 'mentions', 'mention_entities', 'mention_topics', 'sentiment_results', 'story_clusters', 'alert_rules',
  'alert_events', 'reports', 'report_sources', 'subscriptions', 'usage_records', 'retention_policies', 'audit_events',
  'alert_rule_versions', 'detected_issues', 'alert_evidence', 'alert_assignments', 'alert_notes', 'notification_preferences',
  'notification_deliveries', 'webhook_endpoints', 'webhook_deliveries', 'activity_hourly', 'topic_activity_daily', 'alert_evaluations'];

describe('migrations', () => {
  let c: Client;
  beforeAll(async () => { c = new Client({ connectionString: OWNER_URL }); await c.connect(); });
  afterAll(() => c.end());

  it('re-running is a no-op', async () => {
    expect(await migrate({ connectionString: OWNER_URL })).toEqual([]);
  });

  it('refuses to proceed when an applied migration was edited', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-'));
    cpSync(MIGRATIONS_DIR, dir, { recursive: true });
    appendFileSync(join(dir, '0001_identity_tenancy_audit.sql'), '\n-- tampered\n');
    await expect(migrate({ connectionString: OWNER_URL, dir })).rejects.toThrow(/modified after being applied/);
  });

  it('creates every required table', async () => {
    const r = await c.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`);
    const names = r.rows.map((x) => x.tablename);
    for (const t of REQUIRED) expect(names).toContain(t);
  });

  it('every application table has RLS enabled AND forced', async () => {
    const r = await c.query(`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relname <> 'schema_migrations'`);
    for (const row of r.rows) expect([row.relname, row.relrowsecurity, row.relforcerowsecurity]).toEqual([row.relname, true, true]);
  });

  it('app role is restricted and owns nothing', async () => {
    const r = await c.query(`SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = 'civicsignal_app'`);
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false });
    const owned = await c.query(`SELECT count(*)::int n FROM pg_class WHERE relowner = 'civicsignal_app'::regrole`);
    expect(owned.rows[0].n).toBe(0);
  });

  it('every tenant-owned table has a tenant_id column', async () => {
    const r = await c.query(`SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id'`);
    const withTenant = new Set(r.rows.map((x) => x.table_name));
    for (const t of REQUIRED.filter((t) => !['tenants', 'users'].includes(t))) expect(withTenant.has(t)).toBe(true);
  });
});

describe('app role session privileges', () => {
  it('cannot create temporary tables (no shadowing of real tables)', async () => {
    const { APP_URL } = await import('../env');
    const c = new Client({ connectionString: APP_URL }); await c.connect();
    await expect(c.query('CREATE TEMP TABLE users (id int)')).rejects.toThrow(/permission denied/);
    await c.end();
  });
});
