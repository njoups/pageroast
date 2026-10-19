import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

export const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', '..', 'db', 'migrations');

export interface MigrateOptions {
  connectionString: string;
  dir?: string;
  /** If set, the restricted app role is given LOGIN with this password. */
  appRolePassword?: string;
  log?: (msg: string) => void;
}

/**
 * Applies pending SQL migrations in filename order. Each file runs in its own transaction and is
 * recorded with a checksum; editing an already-applied file is an error (migrations are immutable).
 */
export async function migrate(opts: MigrateOptions): Promise<string[]> {
  const log = opts.log ?? (() => undefined);
  const dir = opts.dir ?? MIGRATIONS_DIR;
  const files = readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  const client = new Client({ connectionString: opts.connectionString });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock(727001)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const { rows } = await client.query<{ version: string; checksum: string }>('SELECT version, checksum FROM schema_migrations');
    const ledger = new Map(rows.map((r) => [r.version, r.checksum]));
    for (const file of files) {
      const sql = readFileSync(join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const prior = ledger.get(file);
      if (prior) {
        if (prior !== checksum) throw new Error(`Migration ${file} was modified after being applied`);
        continue;
      }
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
      applied.push(file);
      log(`applied ${file}`);
    }
    if (opts.appRolePassword) {
      const { rows: r } = await client.query<{ stmt: string }>(
        `SELECT format('ALTER ROLE civicsignal_app LOGIN PASSWORD %L', $1::text) AS stmt`, [opts.appRolePassword]);
      await client.query(r[0]!.stmt);
    }
    await client.query('GRANT USAGE ON SCHEMA public TO civicsignal_app');
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => undefined);
    await client.end();
  }
  return applied;
}
