#!/usr/bin/env bash
# check-stale.sh — is any running pool service on older code than the tree?
#
# Incident 2026-08-14: the accounting service ran for two days on code from
# before two critical nonce fixes and silently wrote off two won mainnet
# blocks (~1,605 CKB) as orphans. Node caches modules at require() time, so
# editing and committing a fix does nothing to a process already running.
# Nothing in the system could see the difference: clean tree, green CI.
#
# Run after every deploy, and from cron. Exit 1 if anything has drifted.
#
#   deploy/check-stale.sh                 # check localhost defaults
#   POOL_METRICS_URLS="http://host:9101/metrics,..." deploy/check-stale.sh
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HEAD_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"

# services exposing pool_build_info on a Prometheus endpoint
URLS="${POOL_METRICS_URLS:-http://127.0.0.1:9101/metrics,http://127.0.0.1:9102/metrics}"

if [ "$HEAD_SHA" = "unknown" ]; then
  echo "cannot resolve repo HEAD at $REPO_ROOT — is this a git checkout?" >&2
  exit 2
fi

echo "tree HEAD: $HEAD_SHA"
drift=0
checked=0

IFS=',' read -ra LIST <<< "$URLS"
for url in "${LIST[@]}"; do
  url="$(echo "$url" | xargs)"   # trim
  [ -z "$url" ] && continue

  body="$(curl -s -m 5 "$url" 2>/dev/null)"
  if [ -z "$body" ]; then
    echo "  UNREACHABLE  $url"
    drift=1
    continue
  fi

  line="$(echo "$body" | grep '^pool_build_info{' | head -1)"
  if [ -z "$line" ]; then
    # a service too old to report its build is, by definition, stale
    echo "  NO STAMP     $url  (predates build-info — restart it)"
    drift=1
    continue
  fi

  commit="$(echo "$line" | sed -n 's/.*commit="\([^"]*\)".*/\1/p')"
  started="$(echo "$line" | sed -n 's/.*started_at="\([^"]*\)".*/\1/p')"
  checked=$((checked + 1))

  if [ "$commit" = "$HEAD_SHA" ]; then
    echo "  ok           $url  ${commit:0:7}  (started $started)"
  else
    echo "  STALE        $url  running ${commit:0:7}, tree is ${HEAD_SHA:0:7}  (started $started)"
    drift=1
  fi
done

if [ "$drift" -ne 0 ]; then
  echo
  echo "STALE SERVICES DETECTED — restart them before trusting their output." >&2
  echo "A stale accounting service silently discards won blocks." >&2
  exit 1
fi

echo "all $checked service(s) current"
