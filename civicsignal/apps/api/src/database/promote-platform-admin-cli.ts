import { Client } from 'pg';

/**
 * Operator-only: grants the platform_admin flag. Runs with the owner connection, outside the API.
 * Platform admins get tenant *metadata* endpoints only; they have no implicit access to customer content.
 */
const email = process.argv[2]?.toLowerCase();
const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!email || !url) {
  console.error('Usage: MIGRATION_DATABASE_URL=... tsx promote-platform-admin-cli.ts <email>');
  process.exit(1);
}
(async () => {
  const c = new Client({ connectionString: url });
  await c.connect();
  const r = await c.query('UPDATE users SET is_platform_admin = true WHERE email = $1', [email]);
  await c.query(
    `INSERT INTO audit_events (tenant_id, action, target_type, target_id, metadata)
     SELECT NULL, 'platform_admin.granted', 'user', id::text, '{"via":"operator_cli"}' FROM users WHERE email = $1`, [email]);
  await c.end();
  console.log(r.rowCount ? `Granted platform_admin to ${email}` : `No user with email ${email}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
