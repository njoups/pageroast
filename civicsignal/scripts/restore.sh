#!/usr/bin/env bash
# Restore a scripts/backup.sh dump into an EMPTY database, with the application role's privileges exactly as backed up.
# Usage: TARGET_DATABASE_URL=... [APP_DB_PASSWORD=...] scripts/restore.sh backup.dump
# APP_DB_PASSWORD sets the password of civicsignal_app, a role shared by EVERY database on the server. Set it only when
# restoring onto a new server; on a server that also hosts the live database, leave it unset (the role keeps its
# current password) or the running application is locked out.
# Then prove it: scripts/verify-restore.sh (restores into a scratch database and compares rows, privileges and audit chains).
set -euo pipefail
: "${TARGET_DATABASE_URL:?set TARGET_DATABASE_URL (owner role, empty database)}"
file="${1:?backup file required}"
dir="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$file.sha256" ] && ( cd "$(dirname "$file")" && sha256sum -c "$(basename "$file").sha256" )
# Dumps made without privileges (before 2026-10-20) cannot restore the column-level grants; refuse rather than over-grant.
acl_entries=$(pg_restore -l "$file" | grep -c ' ACL ' || true)
[ "$acl_entries" -gt 0 ] || { echo "refusing: $file has no privilege entries (made with --no-privileges); restore it manually and re-apply grants from the migrations" >&2; exit 1; }
[ "$(psql "$TARGET_DATABASE_URL" -X -At -c "SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace")" = 0 ] || { echo "refusing: target database is not empty" >&2; exit 1; }
# The civicsignal_app role is cluster-level; create it first if this is a fresh cluster.
psql "$TARGET_DATABASE_URL" -X -v ON_ERROR_STOP=1 -qc "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='civicsignal_app') THEN CREATE ROLE civicsignal_app NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END \$\$;"
pg_restore --no-owner --exit-on-error --dbname "$TARGET_DATABASE_URL" "$file"
# Applies any migration newer than the backup and (with APP_DB_PASSWORD) sets the app role's login password.
( cd "$dir" && MIGRATION_DATABASE_URL="$TARGET_DATABASE_URL" npm run -s migrate -w apps/api )
echo "Restore complete. Prove it with scripts/verify-restore.sh before relying on it."
