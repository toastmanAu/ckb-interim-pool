#!/usr/bin/env bash
# node-snapshot.sh — seed a new CKB node from a fully synced node's data dir.
#
# Run ON THE SYNCED NODE (e.g. .105). Transfers the chain DB to the target
# VPS over SSH with compression + resume. The node must be STOPPED during
# the copy (clean RocksDB — never copy a live DB).
#
#   deploy/node-snapshot.sh <vps-user@vps-ip> [--no-compress]
#
# After the copy, on the VPS: place the data dir where the node expects it
# (data/db under the node's home), start ckb, verify with get_tip_header.
set -euo pipefail

TARGET="${1:?usage: node-snapshot.sh <vps-user@vps-ip> [--no-compress]}"
COMPRESS="${2:---compress}"
DATA_DIR="${CKB_DATA_DIR:-$HOME/data}"

DB="$DATA_DIR/db"
if [ ! -d "$DB" ]; then
  echo "no db at $DB — set CKB_DATA_DIR" >&2
  exit 1
fi
SIZE=$(du -sh "$DB" | cut -f1)
echo "db size: $SIZE — transfer may take many hours depending on uplink"

read -r -p "Node must be stopped for a clean copy. Continue? [y/N] " ans
[ "$ans" = "y" ] || { echo aborted; exit 1; }

# rsync with resume, progress, compression; excludes transient/network data
rsync -a --info=progress2 --partial $COMPRESS -e ssh \
  --exclude 'LOCK' --exclude 'CURRENT.bak' --exclude '*.sst.tmp' \
  "$DB/" "$TARGET:$HOME/ckb-node-data/db/"

echo "✔ transfer complete — on the VPS:"
echo "  1. mkdir -p ~/ckb-node-data && mv ~/ckb-node-data/db <node-home>/data/db"
echo "  2. start ckb (it will resume from the copied tip and catch up)"
echo "  3. curl -s <rpc> -d '{\"method\":\"get_tip_header\"}' to verify"
