import { migrate } from './migrate';

const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('Set MIGRATION_DATABASE_URL (owner role) before running migrations.');
  process.exit(1);
}
migrate({ connectionString: url, appRolePassword: process.env.APP_DB_PASSWORD, log: console.log })
  .then((applied) => console.log(applied.length ? `Applied ${applied.length} migration(s).` : 'Database is up to date.'))
  .catch((err) => { console.error(err.message); process.exit(1); });
