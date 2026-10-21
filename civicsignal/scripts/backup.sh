#!/usr/bin/env bash
# Logical backup (pg_dump custom format) using the OWNER connection, with a row-count manifest and checksum.
#   MIGRATION_DATABASE_URL=... scripts/backup.sh [outfile]
# Optional encryption at rest: BACKUP_GPG_RECIPIENT=<key id/email> encrypts the dump with gpg (public key only on this
# host); the plaintext dump is removed. Without it the script warns: the dump contains customer data.
# This complements, and does not replace, managed PostgreSQL snapshots/PITR (docs/BACKUP_AND_RECOVERY.md).
# Optional monitoring: BACKUP_METRICS_FILE=/var/lib/node_exporter/textfile/civicsignal_backup.prom writes the time and
# size of the last SUCCESSFUL backup for the node_exporter textfile collector (alert: CivicSignalBackupStale in
# infra/monitoring/alerts.yml). A failed run leaves the previous timestamp, so the alert fires when backups stop.
set -euo pipefail
: "${MIGRATION_DATABASE_URL:?set MIGRATION_DATABASE_URL to the owner connection string}"
out="${1:-backup-$(date -u +%Y%m%dT%H%M%SZ).dump}"
umask 077
# Privileges are kept: the application role's table, column and function grants are part of the security model and are
# restored exactly (scripts/restore.sh); ownership is not (the restoring owner role owns the objects).
pg_dump --format=custom --no-owner --file "$out" "$MIGRATION_DATABASE_URL"
# Manifest: exact row counts per table and applied migrations, used by verify-restore.sh to prove a restore is complete.
psql "$MIGRATION_DATABASE_URL" -X -q -At -v ON_ERROR_STOP=1 <<'SQL' > "$out.manifest"
SET row_security = off;
SELECT 'migration ' || version FROM schema_migrations ORDER BY version;
SELECT format('rows %s %s', c.relname, (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', c.relname), false, true, '')))[1]::text)
FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' ORDER BY c.relname;
SQL
psql "$MIGRATION_DATABASE_URL" -X -q -At -v ON_ERROR_STOP=1 -f "$(dirname "$0")/sql/app-privileges.sql" >> "$out.manifest"
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
if [ -n "${BACKUP_METRICS_FILE:-}" ]; then
  final="$out"; [ -n "${BACKUP_GPG_RECIPIENT:-}" ] && final="$out.gpg"
  tmp="$BACKUP_METRICS_FILE.$$"
  {
    echo '# HELP civicsignal_backup_last_success_timestamp_seconds Time of the last successful logical backup.'
    echo '# TYPE civicsignal_backup_last_success_timestamp_seconds gauge'
    echo "civicsignal_backup_last_success_timestamp_seconds $(date +%s)"
    echo '# HELP civicsignal_backup_last_size_bytes Size of the last successful logical backup.'
    echo '# TYPE civicsignal_backup_last_size_bytes gauge'
    echo "civicsignal_backup_last_size_bytes $(stat -c %s "$final")"
  } > "$tmp" && chmod 644 "$tmp" && mv -f "$tmp" "$BACKUP_METRICS_FILE"
fi
