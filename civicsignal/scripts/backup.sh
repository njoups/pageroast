#!/usr/bin/env bash
# Logical backup using the OWNER connection. Usage: MIGRATION_DATABASE_URL=... scripts/backup.sh [outfile]
set -euo pipefail
: "${MIGRATION_DATABASE_URL:?set MIGRATION_DATABASE_URL to the owner connection string}"
out="${1:-backup-$(date -u +%Y%m%dT%H%M%SZ).dump}"
pg_dump --format=custom --no-owner --no-privileges --file "$out" "$MIGRATION_DATABASE_URL"
sha256sum "$out" > "$out.sha256"
echo "Backup written to $out (checksum in $out.sha256). Store it encrypted; it contains customer data."
