#!/usr/bin/env bash
# Restore into an EMPTY database, then re-apply grants/RLS-role setup via migrations.
# Usage: TARGET_DATABASE_URL=... APP_DB_PASSWORD=... scripts/restore.sh backup.dump
set -euo pipefail
: "${TARGET_DATABASE_URL:?set TARGET_DATABASE_URL (owner role, empty database)}"
file="${1:?backup file required}"
[ -f "$file.sha256" ] && sha256sum -c "$file.sha256"
# The civicsignal_app role is cluster-level; create it first if this is a fresh cluster.
psql "$TARGET_DATABASE_URL" -v ON_ERROR_STOP=1 -qc "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='civicsignal_app') THEN CREATE ROLE civicsignal_app NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END \$\$;"
pg_restore --no-owner --no-privileges --exit-on-error --dbname "$TARGET_DATABASE_URL" "$file"
# Grants were excluded from the dump; re-apply them idempotently.
psql "$TARGET_DATABASE_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
GRANT USAGE ON SCHEMA public TO civicsignal_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO civicsignal_app;
REVOKE ALL ON schema_migrations FROM civicsignal_app;
REVOKE UPDATE, DELETE ON audit_events FROM civicsignal_app;
REVOKE DELETE ON users FROM civicsignal_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO civicsignal_app;
SQL
MIGRATION_DATABASE_URL="$TARGET_DATABASE_URL" npm run -s migrate -w apps/api
echo "Restore complete. Verify with: npm test (against a copy) and a smoke login."
