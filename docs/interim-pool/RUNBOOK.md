# Pool Operator Runbook — CKB Interim Pool

Operational procedures for the custodial interim pool. Keep this current;
the launch gates (spec 07 §11) reference it.

## 1. Topology

```
miners ── stratum ── pool-edge (per region, next to a local CKB node)
                          │  mTLS NATS JetStream (per-edge creds)
                          ▼
              ingest (PostgreSQL) ── api/dashboard
                          │
                   payout worker (private, keys here only)
                          │
                   CKB node RPC (private)
```

Central services colocated on one hardened host (separate systemd units +
credentials so they can split later).

## 2. Startup order

1. PostgreSQL → `deploy/pg-test.sh` (dev) or the prod instance; migrations
   run automatically by the ingest unit.
2. NATS (TLS) → `deploy/nats-server.conf` with certs from
   `deploy/gen-nats-tls.sh` (CA + server + per-edge + ingest client certs).
3. Ingest: `systemctl start pool-ingest` (waits/retries until the stream
   exists — edges may boot first).
4. Edges: `systemctl start pool-edge@<region>` — first edge creates the
   `POOL_V1` stream.
5. API: `systemctl start pool-api`.
6. Payout: `systemctl enable --now pool-payout.timer` (hourly; dry-run mode
   until the testnet drill passes).

Sanity: `curl localhost:9101/health` (ingest), `curl localhost:8080/api/v1/pool`
(api), `curl localhost:8082/health` (edge).

## 3. Daily checks

- `poolctl ledger verify` — conservation across every allocated block.
- `poolctl events replay-status` — per-edge ingestion counts.
- Edge `/health` — `node_healthy` true, template age < 5min.
- Reject/stale rates on the dashboard vs baseline.

## 4. Failure procedures

### Edge down / region lost
- Other regions continue; miners pointed at the dead region should move to a
  backup endpoint (documented region hostnames, spec 06 §3).
- On recovery: start the unit; new boot id; spool replays unacked events.
- Verify: `poolctl events replay-status` catches the gap; alert
  `EdgeSequenceGap` clears.

### Central outage (NATS/PostgreSQL down)
- Edges keep mining; accepted shares spool locally (disk bounded).
- Restore NATS first (edges resume publishing), then PostgreSQL.
- Ingestion is at-least-once + idempotent — replay is safe; watch
  `pool_ingest_events_duplicate_total` for the expected surge.

### Event bus (NATS) down
- Edge spool grows; alert `EdgeSpoolNearCapacity` at 75%.
- If spool fills: the edge fails closed (stops accepting shares, /health
  reports unhealthy) — this is by design, not silent loss.

### Local CKB node down
- Edge stops issuing fresh work and marks itself unhealthy; miners see
  reconnect/temporary failure. Fix the node; edge recovers automatically.

### Payout failure
1. `poolctl payout inspect <batch-id>` — find the state.
2. Items in `RESERVED` were never broadcast: safe to re-run the sweep.
3. Items in `BROADCAST`: the tx hash is in the ledger metadata — confirm on
   the node (`get_transaction`) BEFORE anything else; recovery never
   re-sends a broadcast amount.
4. Escalate manually only with an `adjustment` ledger entry + reason.

### Found block never becomes canonical
- `poolctl block show <hash>`; if `ORPHANED` no credits were posted (by
  design). If stuck in `NODE_ACCEPTED`, check the tracker's node access.

## 5. Backup / restore drill (monthly)

1. `deploy/backup.sh` → dump file.
2. Stop ingest/API/payout units.
3. `deploy/restore.sh <dump>` (confirm with RESTORE).
4. Start units; ingest replays the stream to catch up.
5. `poolctl ledger verify`; compare `poolctl events replay-status` to
   pre-backup state.

## 6. Upgrade procedure

1. Deploy to one non-critical/test region first; verify miner compatibility
   and share rates (K7 acceptance checklist).
2. Rolling restart of regions (`systemctl restart pool-edge@<region>` — each
   restart gets a new boot id; job ids cannot collide across restarts).
3. Accounting schema migrations are backward compatible with at least the
   deployed edge event schema (spec 06 §12).

## 7. Secrets map

| Secret | Location | Never on |
|---|---|---|
| NATS CA + edge client certs | edge hosts `/etc/wyltek-pool/nats-tls/` | CI, repo |
| NATS server key + CA key | central NATS host | edges, repo |
| DB password | central host env | edges, repo, dashboard JS |
| Payout key | payout host only (`POOL_PAYOUT_KEY`) | edges, api, CI |
| CKB RPC | private network only | public internet |

## 8. Region checklist (adding a region)

1. CKB node synced, RPC bound to private interface only.
2. NTP/chrony enabled (ordering depends on clock skew limits).
3. Edge config `deploy/edges/<region>.json`; systemd unit instance.
4. NATS client cert `edge-<region>` added to `gen-nats-tls.sh` + server
   authorization block (publish scoped to `pool.v1.edge.<id>.>`).
5. Explicit region hostname (`<region>.pool.example:3333`), backup endpoint
   documented in the UI (spec 06 §3).
6. Prometheus scrape job + alert rules for the new edge.
7. Firewall: stratum port public, node RPC + stats port private.
