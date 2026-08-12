#!/usr/bin/env bash
# backup.sh — PostgreSQL backup with retention (spec 06 §11).
#
# Usage: deploy/backup.sh [backup-dir]     (default /var/backups/wyltek-pool)
#
# Continuous/daily: run daily via cron/systemd timer; test restore monthly.
set -euo pipefail

DIR="${1:-/var/backups/wyltek-pool}"
DB_URL="${POOL_DB_URL:-postgres://pool:pooltest@127.0.0.1:5433/pooltest}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
mkdir -p "$DIR"

STAMP="$(date +%Y%m%d-%H%M%S)"
FILE="$DIR/pool-dump-$STAMP.sql.gz"

# strip the URL for pg_dump
HOST_PORT=$(echo "$DB_URL" | sed -E 's|postgres://[^@]*@([^/]+)/.*|\1|')
HOST="${HOST_PORT%%:*}"
PORT="${HOST_PORT##*:}"
USER_DB=$(echo "$DB_URL" | sed -E 's|postgres://([^:@]+):[^@]*@.*|\1|')
DB=$(echo "$DB_URL" | sed -E 's|.*/([^/]+)$|\1|')

PGPASSWORD="$(echo "$DB_URL" | sed -E 's|postgres://[^:]+:([^@]+)@.*|\1|')" \
  pg_dump -h "$HOST" -p "$PORT" -U "$USER_DB" -d "$DB" \
    --format=custom --compress=3 > "$FILE"

# retention
find "$DIR" -name 'pool-dump-*.sql.gz' -mtime +"$RETENTION_DAYS" -delete

echo "backup: $FILE ($(du -h "$FILE" | cut -f1))"
