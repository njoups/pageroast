#!/usr/bin/env bash
# Restore drill: restores a backup into a NEW scratch database and proves it is complete and still secure.
#   ADMIN_DATABASE_URL=postgres://<superuser>@host/postgres scripts/verify-restore.sh backup.dump[.gpg]
# Checks (any failure exits non-zero):
#   1. checksum of the dump and manifest;
#   2. restore into a fresh database (never into an existing one);
#   3. migrations: every migration in the manifest is present (newer ones applied by restore.sh are listed);
#   4. rows: exact per-table counts equal to the manifest;
#   5. security: forced RLS on every table, the application role is not superuser/BYPASSRLS and owns nothing, and its
#      table/column/function privileges equal the manifest (a restore must not widen them);
#   6. audit: every hash chain verifies (audit_verify_chain) and matches its stored head.
# The scratch database is dropped at the end unless KEEP_RESTORE_DB=1. Prints counts and verdicts, never data.
set -euo pipefail
: "${ADMIN_DATABASE_URL:?set ADMIN_DATABASE_URL (a role that can CREATE/DROP DATABASE and read every row, e.g. the cluster superuser)}"
file="${1:?backup file required}"
base="${file%.gpg}"
dir="$(cd "$(dirname "$0")/.." && pwd)"
started=$(date +%s)

echo "[1/6] checksums"
( cd "$(dirname "$file")" && sha256sum -c "$(basename "$base").sha256" )
dump="$file"
if [[ "$file" == *.gpg ]]; then dump="$(mktemp)"; gpg --batch --yes --quiet --output "$dump" --decrypt "$file"; trap 'rm -f "$dump"' EXIT; fi

db="restore_drill_$(date -u +%Y%m%d%H%M%S)"
target="$(python3 -c 'import sys,urllib.parse as u; p=u.urlsplit(sys.argv[1]); print(u.urlunsplit(p._replace(path="/"+sys.argv[2])))' "$ADMIN_DATABASE_URL" "$db")"
echo "[2/6] restore into new database $db"
psql "$ADMIN_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE $db"
cleanup() { [ "${KEEP_RESTORE_DB:-0}" = 1 ] || psql "$ADMIN_DATABASE_URL" -X -q -c "DROP DATABASE IF EXISTS $db WITH (FORCE)" >/dev/null 2>&1 || true; }
trap 'cleanup; [ "$dump" != "$file" ] && rm -f "$dump"' EXIT
# civicsignal_app is a CLUSTER-level role shared with the live database on the same server: the drill must never set its
# password, or the running application loses its connections (found in the 2026-10-21 drill). APP_DB_PASSWORD is
# therefore removed from the restore's environment.
env -u APP_DB_PASSWORD TARGET_DATABASE_URL="$target" bash "$dir/scripts/restore.sh" "$dump" >/dev/null

echo "[3/6] migrations"
restored_migrations="$(psql "$target" -X -At -c "SELECT 'migration ' || version FROM schema_migrations ORDER BY version")"
missing="$(comm -23 <(grep '^migration ' "$base.manifest" | sort) <(echo "$restored_migrations" | sort))"
[ -z "$missing" ] || { echo "restore drill: migrations in the backup are missing after restore:" >&2; echo "$missing" >&2; exit 1; }
newer="$(comm -13 <(grep '^migration ' "$base.manifest" | sort) <(echo "$restored_migrations" | sort) | sed 's/^migration //' | paste -sd, -)"
echo "  all $(grep -c '^migration ' "$base.manifest") backed-up migrations present${newer:+; applied after restore: $newer}"

echo "[4/6] row counts"
actual="$(psql "$target" -X -q -At <<'SQL'
SET row_security = off;
SELECT format('rows %s %s', c.relname, (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', c.relname), false, true, '')))[1]::text)
FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' ORDER BY c.relname;
SQL
)"
diff <(grep '^rows ' "$base.manifest" | grep -v '^rows schema_migrations ') <(echo "$actual" | grep -v '^rows schema_migrations ')
echo "  $(echo "$actual" | wc -l) tables, $(echo "$actual" | awk '{s+=$3} END {print s}') rows: identical to manifest"

echo "[5/6] security posture"
psql "$target" -X -q -At -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relname <> 'schema_migrations' AND NOT (relrowsecurity AND relforcerowsecurity);
  IF n > 0 THEN RAISE EXCEPTION 'restore drill: % table(s) without forced RLS', n; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'civicsignal_app' AND (rolsuper OR rolbypassrls)) THEN RAISE EXCEPTION 'restore drill: app role can bypass RLS'; END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE relowner = 'civicsignal_app'::regrole) THEN RAISE EXCEPTION 'restore drill: app role owns objects'; END IF;
END $$;
SELECT '  forced RLS on all tables; app role restricted';
SQL
diff <(grep '^acl' "$base.manifest") <(cd "$dir" && psql "$target" -X -q -At -v ON_ERROR_STOP=1 -f scripts/sql/app-privileges.sql) \
  || { echo "restore drill: application role privileges differ from the backup (lines above)" >&2; exit 1; }
echo "  app role privileges identical to manifest ($(grep -c '^acl' "$base.manifest") objects)"

echo "[6/6] audit hash chains"
psql "$target" -X -q -At -v ON_ERROR_STOP=1 <<'SQL'
SET row_security = off;
DO $$
DECLARE r record; v record; bad int := 0; total bigint := 0; chains int := 0;
BEGIN
  FOR r IN SELECT chain FROM audit_chain_heads LOOP
    SELECT * INTO v FROM audit_verify_chain(r.chain);
    chains := chains + 1; total := total + v.checked;
    IF v.first_bad_id IS NOT NULL OR NOT coalesce(audit_verify_head(r.chain), false) THEN bad := bad + 1; RAISE WARNING 'chain % fails at %', r.chain, v.first_bad_id; END IF;
  END LOOP;
  IF bad > 0 THEN RAISE EXCEPTION 'restore drill: % audit chain(s) failed verification', bad; END IF;
  RAISE NOTICE '  % audit chain(s), % event(s): all verify', chains, total;
END $$;
SQL
echo "Restore drill passed in $(( $(date +%s) - started ))s (database $db $([ "${KEEP_RESTORE_DB:-0}" = 1 ] && echo kept || echo dropped))."
