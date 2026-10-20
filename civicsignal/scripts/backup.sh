#!/usr/bin/env bash
# Logical backup (pg_dump custom format) using the OWNER connection, with a row-count manifest and checksum.
#   MIGRATION_DATABASE_URL=... scripts/backup.sh [outfile]
# Optional encryption at rest: BACKUP_GPG_RECIPIENT=<key id/email> encrypts the dump with gpg (public key only on this
# host); the plaintext dump is removed. Without it the script warns: the dump contains customer data.
# This complements, and does not replace, managed PostgreSQL snapshots/PITR (docs/BACKUP_AND_RECOVERY.md).
set -euo pipefail
: "${MIGRATION_DATABASE_URL:?set MIGRATION_DATABASE_URL to the owner connection string}"
out="${1:-backup-$(date -u +%Y%m%dT%H%M%SZ).dump}"
umask 077
pg_dump --format=custom --no-owner --no-privileges --file "$out" "$MIGRATION_DATABASE_URL"
# Manifest: exact row counts per table and applied migrations, used by verify-restore.sh to prove a restore is complete.
psql "$MIGRATION_DATABASE_URL" -X -q -At -v ON_ERROR_STOP=1 <<'SQL' > "$out.manifest"
SET row_security = off;
SELECT 'migration ' || version FROM schema_migrations ORDER BY version;
SELECT format('rows %s %s', c.relname, (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', c.relname), false, true, '')))[1]::text)
FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' ORDER BY c.relname;
SQL
sha256sum "$out" "$out.manifest" > "$out.sha256"
if [ -n "${BACKUP_GPG_RECIPIENT:-}" ]; then
  gpg --batch --yes --trust-model always --recipient "$BACKUP_GPG_RECIPIENT" --output "$out.gpg" --encrypt "$out"
  rm -f "$out"
  sha256sum "$out.gpg" "$out.manifest" > "$out.sha256"
  echo "Encrypted backup written to $out.gpg (manifest $out.manifest, checksums $out.sha256)."
else
  echo "Backup written to $out (manifest $out.manifest, checksums $out.sha256)."
  echo "WARNING: not encrypted. Set BACKUP_GPG_RECIPIENT, or store it only on encrypted storage: it contains customer data." >&2
fi
