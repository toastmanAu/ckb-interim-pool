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

## 8. Public endpoints without exposing the home IP

Explicit region hostnames are mandatory (spec 06 §3 — ASIC DNS caching
varies). To keep the operator's direct IP private when community miners
connect:

- **Baseline**: `au.pool.example:3333` → A record → home IP. Simplest, but
  the IP is discoverable via DNS and port scans.
- **Recommended**: cheap region VPS running a TCP reverse proxy
  (`deploy/proxy/nginx-stream.conf` or `haproxy.cfg`) over
  WireGuard/Tailscale to the edge. Miners only ever see the VPS IP;
  enables DDoS absorption and rate limiting at the edge of the network.
  Enable `limits.proxyProtocol` in the edge config and
  `send-proxy-v2` / `proxy_protocol on` on the proxy so the edge sees
  real miner IPs for its per-IP connection limits.
- **Strongest**: Cloudflare Spectrum (paid, anycast TCP — the origin IP
  is never exposed; `deploy/proxy/cloudflared.yml` shows the free
  tunnel variant, which is HTTP-oriented and less suitable for stratum).

Public surface from the edge host: **only the stratum port** (default
3333). The stats/metrics port binds 127.0.0.1 in the region config; the
CKB node RPC (8114) is never exposed outside the private network.

## 9. Global community deployment (multi-region)

The community is global, so run **full regional edges on VPSes**, not just
proxies: each region gets its own `pool-edge` + CKB node on the same VPS
(low-latency tip→notify path per spec 02 §1), publishing to the central
NATS bus over mTLS. Miners in each region use the explicit region hostname;
the operator's home IP is never involved.

Endpoint matrix (explicit hostnames, never removed — spec 06 §3):

| Region | Hostname | Deployment |
|---|---|---|
| AU | `au.pool.example:3333` | home edge + local node (this host), optionally behind a VPS proxy for IP hiding |
| EU | `eu.pool.example:3333` | VPS edge + CKB node (`deploy/edges/eu-frankfurt-01.json`) |
| US | `us.pool.example:3333` | VPS edge + CKB node (`deploy/edges/us-virginia-01.json`) |
| Asia | `asia.pool.example:3333` | VPS edge + CKB node (`deploy/edges/asia-singapore-01.json`) |

Per-VPS setup:
1. Full CKB node (RPC bound to 127.0.0.1 — never public).
2. `pool-edge` via the systemd unit or compose; the region config assumes
   the node is on the VPS (`node.host: 127.0.0.1`).
3. mTLS NATS client cert for the region (`deploy/gen-nats-tls.sh` +
   `nats-server.conf` authorization entries — certs for eu/us already
   generated; asia needs an entry added).
4. GeoDNS: optional later, when several VPS edges exist. Never remove the
   explicit hostnames (ASIC DNS caching varies).

For the AU region specifically, the operator's home edge stays local to
the K7; if its IP should stay private, put a region VPS proxy in front
(§8) with `proxyProtocol` enabled.

## 10. Region checklist (adding a region)

1. CKB node synced, RPC bound to private interface only.
2. NTP/chrony enabled (ordering depends on clock skew limits).
3. Edge config `deploy/edges/<region>.json`; systemd unit instance.
4. NATS client cert `edge-<region>` added to `gen-nats-tls.sh` + server
   authorization block (publish scoped to `pool.v1.edge.<id>.>`).
5. Explicit region hostname (`<region>.pool.example:3333`), backup endpoint
   documented in the UI (spec 06 §3).
6. Prometheus scrape job + alert rules for the new edge.
7. Firewall: stratum port public, node RPC + stats port private.
