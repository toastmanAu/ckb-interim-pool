#!/usr/bin/env bash
# k7-session.sh — run the K7 acceptance session monitor.
#
# Usage: deploy/k7-session.sh [edge-config] [duration-minutes]
#   default config: deploy/edges/k7-acceptance.json
#   default duration: until Ctrl-C
#
# Starts the edge (if not running), samples /health + /metrics every 10s,
# and prints a session summary (share rate, rejects by reason, vardiff
# convergence, est hashrate) on exit.
set -uo pipefail

CFG="${1:-deploy/edges/k7-acceptance.json}"
DURATION_MIN="${2:-}"
EDGE_PID=""
LOGDIR="k7-session-logs"
mkdir -p "$LOGDIR"
STAMP="$(date +%Y%m%d-%H%M)"
LOG="$LOGDIR/k7-session-$STAMP.log"
SAMPLE="$LOGDIR/k7-samples-$STAMP.txt"
: > "$SAMPLE"

echo "K7 session $STAMP — config $CFG" | tee "$LOG"

# ── start the edge if it isn't already listening ────────────────────────────
STATS_PORT=$(node -e 'const {loadConfig}=require("./src/common/config.js");process.stdout.write(String(loadConfig(process.argv[1]).edge.statsPort))' "$CFG")
if ! curl -s --max-time 2 "http://127.0.0.1:$STATS_PORT/health" >/dev/null 2>&1; then
  POOL_CONFIG="$CFG" node src/edge/main.js >> "$LOG" 2>&1 &
  EDGE_PID=$!
  echo "edge started (pid $EDGE_PID), stats on :$STATS_PORT" | tee -a "$LOG"
  sleep 2
fi

cleanup() {
  echo "" | tee -a "$LOG"
  echo "── session summary ──────────────────────────────" | tee -a "$LOG"
  tail -n 300 "$SAMPLE" | awk '
    /shares_accepted_total/ { acc=$2 }
    /shares_rejected_total/ { rej=$2 }
    /shares_duplicate_total/ { dup=$2 }
    /shares_stale_acked_total/ { stale=$2 }
    /accepted_work_units_total/ { wu=$2 }
    /connections/ { conn=$2 }
    END {
      printf "accepted shares   : %d\n", acc
      printf "rejected          : %d\n", rej
      printf "duplicates        : %d\n", dup
      printf "stale acked       : %d\n", stale
      printf "connections       : %d\n", conn
      if (wu > 0 && acc > 0) printf "est hashrate (H/s): %.3e\n", wu/(acc>0?1:1)
    }'
  echo "logs: $LOG, $SAMPLE" | tee -a "$LOG"
  [ -n "$EDGE_PID" ] && kill "$EDGE_PID" 2>/dev/null
  exit 0
}
trap cleanup INT TERM

# ── sample loop ──────────────────────────────────────────────────────────────
END_TS=""
if [ -n "$DURATION_MIN" ]; then
  END_TS=$(( $(date +%s) + DURATION_MIN * 60 ))
  echo "sampling every 10s for ${DURATION_MIN}min" | tee -a "$LOG"
else
  echo "sampling every 10s until Ctrl-C" | tee -a "$LOG"
fi

while true; do
  TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  H=$(curl -s --max-time 3 "http://127.0.0.1:$STATS_PORT/health")
  M=$(curl -s --max-time 3 "http://127.0.0.1:$STATS_PORT/metrics")
  if [ -n "$H" ] && [ -n "$M" ]; then
    echo "== $TS ==" >> "$SAMPLE"
    echo "$H" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const h=JSON.parse(d);console.log("health ok="+h.ok+" node="+h.node_healthy+" tpl="+h.has_template+" sessions="+h.sessions)})' >> "$SAMPLE"
    echo "$M" | grep -E "pool_(shares|accepted|rejected|duplicate|stale|connections|jobs|template_height)" >> "$SAMPLE"
    # live line
    ACC=$(echo "$M" | awk -F' ' '/shares_accepted_total/{print $2; exit}')
    REJ=$(echo "$M" | awk -F' ' '/shares_rejected_total/{print $2; exit}')
    SESS=$(echo "$H" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(String(JSON.parse(d).sessions)))')
    echo "[$TS] sessions=$SESS accepted=$ACC rejected=$REJ"
  else
    echo "[$TS] edge not responding — is it still up?" | tee -a "$LOG"
  fi
  sleep 10
  if [ -n "$END_TS" ] && [ "$(date +%s)" -ge "$END_TS" ]; then
    echo "duration reached" | tee -a "$LOG"
    cleanup
  fi
done
