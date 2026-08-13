#!/usr/bin/env bash
# run-k7-edge.sh — detached launcher for the K7 acceptance edge.
exec env POOL_CONFIG=/home/phill/wyltek-pool/deploy/edges/au-adelaide-01.json \
  node /home/phill/wyltek-pool/src/edge/main.js
