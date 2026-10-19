import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { APP_URL, OWNER_URL } from '../env';

/** Exercises isolation directly against Postgres as the application role, independent of API code. */
describe('row-level security (database level)', () => {
  const owner = new Client({ connectionString: OWNER_URL });
  const app = new Pool({ connectionString: APP_URL });
  const A = randomUUID(); const B = randomUUID(); const user = randomUUID();
  let projA: string; let projB: string;

  async function as<T>(ctx: { tenant?: string; user?: string; system?: boolean }, sql: string, params: unknown[] = []): Promise<T[]> {
    const c = await app.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.user_id',$2,true), set_config('app.system',$3,true)`,
        [ctx.tenant ?? '', ctx.user ?? '', ctx.system ? 'on' : '']);
      const r = await c.query(sql, params);
      await c.query('COMMIT');
      return r.rows as T[];
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }

  beforeAll(async () => {
    await owner.connect();
    await owner.query(`INSERT INTO users (id, email, display_name, password_hash) VALUES ($1, $2, 'R', 'x')`, [user, `rls-${user}@example.test`]);
    await owner.query(`INSERT INTO tenants (id, name, slug) VALUES ($1,'Tenant A',$3), ($2,'Tenant B',$4)`, [A, B, `a-${A.slice(0, 8)}`, `b-${B.slice(0, 8)}`]);
    await owner.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1,$2,'owner')`, [A, user]);
    projA = (await owner.query(`INSERT INTO projects (tenant_id, name) VALUES ($1,'Alpha') RETURNING id`, [A])).rows[0].id;
    projB = (await owner.query(`INSERT INTO projects (tenant_id, name) VALUES ($1,'Bravo') RETURNING id`, [B])).rows[0].id;
  });
  afterAll(async () => { await owner.end(); await app.end(); });

  it('tenant A context sees only tenant A projects', async () => {
    const rows = await as<{ id: string }>({ tenant: A }, 'SELECT id FROM projects');
    expect(rows.map((r) => r.id)).toEqual([projA]);
  });

  it('no context sees nothing (fails closed)', async () => {
    expect(await as({}, 'SELECT id FROM projects')).toHaveLength(0);
    expect(await as({}, 'SELECT id FROM tenants')).toHaveLength(0);
    expect(await as({}, 'SELECT id FROM users')).toHaveLength(0);
  });

  it('cannot read tenant B row by id from tenant A', async () => {
    expect(await as({ tenant: A }, 'SELECT id FROM projects WHERE id = $1', [projB])).toHaveLength(0);
  });

  it('cannot insert a row tagged with another tenant', async () => {
    await expect(as({ tenant: A }, `INSERT INTO projects (tenant_id, name) VALUES ($1, 'Sneaky')`, [B])).rejects.toThrow(/row-level security/);
  });

  it('cannot update or delete another tenant\'s rows (silently affects 0 rows)', async () => {
    await as({ tenant: A }, `UPDATE projects SET name = 'pwned' WHERE id = $1`, [projB]);
    await as({ tenant: A }, `DELETE FROM projects WHERE id = $1`, [projB]);
    const r = await owner.query('SELECT name FROM projects WHERE id = $1', [projB]);
    expect(r.rows[0].name).toBe('Bravo');
  });

  it('cannot move a row into another tenant via UPDATE', async () => {
    await expect(as({ tenant: A }, `UPDATE projects SET tenant_id = $2 WHERE id = $1`, [projA, B])).rejects.toThrow();
  });

  it('composite foreign keys block cross-tenant references even for the owner role', async () => {
    await expect(owner.query(`INSERT INTO monitoring_queries (tenant_id, project_id, name, keywords) VALUES ($1,$2,'x','{banjir}')`, [A, projB]))
      .rejects.toThrow(/foreign key/);
  });

  it('a user sees only their own memberships without tenant context', async () => {
    const rows = await as<{ tenant_id: string }>({ user }, 'SELECT tenant_id FROM memberships');
    expect(rows.map((r) => r.tenant_id)).toEqual([A]);
    const tenants = await as<{ id: string }>({ user }, 'SELECT id FROM tenants');
    expect(tenants.map((r) => r.id)).toEqual([A]);
  });

  it('only system context may create tenants', async () => {
    await expect(as({ user }, `INSERT INTO tenants (name, slug) VALUES ('X', 'xx-nosys')`)).rejects.toThrow(/row-level security/);
  });

  it('audit events are append-only for the app role', async () => {
    await as({ tenant: A }, `INSERT INTO audit_events (tenant_id, action) VALUES ($1, 'test.event')`, [A]);
    await expect(as({ tenant: A }, `UPDATE audit_events SET action = 'x' WHERE tenant_id = $1`, [A])).rejects.toThrow(/permission denied/);
    await expect(as({ tenant: A }, `DELETE FROM audit_events WHERE tenant_id = $1`, [A])).rejects.toThrow(/permission denied/);
  });

  it('audit events are append-only even for the owner role (trigger)', async () => {
    await expect(owner.query(`UPDATE audit_events SET action = 'x'`)).rejects.toThrow(/append-only/);
  });

  it('cannot write audit rows for another tenant', async () => {
    await expect(as({ tenant: A }, `INSERT INTO audit_events (tenant_id, action) VALUES ($1, 'forged')`, [B])).rejects.toThrow(/row-level security/);
  });

  it('every tenant-scoped domain table rejects a mismatched tenant_id on insert', async () => {
    // Representative spot check on tables without composite-FK coverage.
    for (const sql of [
      `INSERT INTO subscriptions (tenant_id, plan_code) VALUES ($1, 'x')`,
      `INSERT INTO usage_records (tenant_id, metric, quantity, period_start) VALUES ($1, 'm', 1, current_date)`,
      `INSERT INTO retention_policies (tenant_id, data_class, retention_days) VALUES ($1, 'reports', 30)`,
      `INSERT INTO sources (tenant_id, name, domain, collection_method) VALUES ($1, 'n', 'd.example', 'rss')`,
    ]) await expect(as({ tenant: A }, sql, [B])).rejects.toThrow(/row-level security/);
  });
});
