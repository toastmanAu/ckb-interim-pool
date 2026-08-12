#!/usr/bin/env bash
# restore.sh — restore a pool backup into PostgreSQL (tested restore drill).
#
# Usage: deploy/restore.sh <dump-file.sql.gz> [db-url]
#
# WARNING: this DROPS the pool schema and restores the dump. Run only when
# the ingest/API/payout services are stopped, or data written after the
# dump will be lost (the dump is the point of restore — replay the event
# stream afterwards to catch up).
set -euo pipefail

DUMP="${1:?usage: restore.sh <dump-file.sql.gz> [db-url]}"
DB_URL="${2:-${POOL_DB_URL:-postgres://pool:pooltest@127.0.0.1:5433/pooltest}}"

HOST_PORT=$(echo "$DB_URL" | sed -E 's|postgres://[^@]*@([^/]+)/.*|\1|')
HOST="${HOST_PORT%%:*}"
PORT="${HOST_PORT##*:}"
USER_DB=$(echo "$DB_URL" | sed -E 's|postgres://([^:@]+):[^@]*@.*|\1|')
DB=$(echo "$DB_URL" | sed -E 's|.*/([^/]+)$|\1|')

echo "restoring $DUMP into $DB (dropping existing pool schema)"
read -r -p "type RESTORE to continue: " ans
[ "$ans" = "RESTORE" ] || { echo aborted; exit 1; }

PGPASSWORD="$(echo "$DB_URL" | sed -E 's|postgres://[^:]+:([^@]+)@.*|\1|')" \
  gunzip -c "$DUMP" | pg_restore -h "$HOST" -p "$PORT" -U "$USER_DB" -d "$DB" --clean --if-exists
echo "restore complete — verify with: node src/accounting/poolctl.js ledger verify"
