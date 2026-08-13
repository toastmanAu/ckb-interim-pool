# 06 — Multi-Region Operations and Security

## 1. Regional objective

The region design exists to reduce the latency-sensitive path:

```text
CKB tip -> template -> Stratum notify -> ASIC
ASIC winning share -> edge validation -> local CKB submit_block
```

Central accounting latency is not allowed onto that synchronous path.

## 2. Region layout

Each region contains:

- one `pool-edge` instance initially;
- one fully synced CKB node on private/local networking;
- persistent edge spool volume;
- metrics/log shipper;
- outbound authenticated connection to event bus.

Production can later use two edges/nodes per region behind TCP load balancing, but session stickiness and unique extranonce allocation must be understood before doing so.

## 3. Endpoint strategy

Initial explicit endpoints are operationally simplest:

```text
au.wyltekpool.com:3333
eu.wyltekpool.com:3333
us.wyltekpool.com:3333
asia.wyltekpool.com:3333
```

Provide backup endpoints in documentation/miner UI.

GeoDNS may be introduced later, but never remove explicit region hostnames because ASIC DNS caching/failover behavior varies.

## 4. CKB RPC security

CKB RPC is trusted/internal infrastructure and must not be Internet exposed.

- bind node RPC to localhost/private interface;
- firewall from miner/public networks;
- only edge/monitoring services can reach it;
- never place RPC credentials/secrets in dashboard JS;
- keep node admin/debug RPC exposure minimal.

## 5. Stratum hardening

- max connections per IP with generous defaults suitable for NATed farms;
- global connection ceiling;
- socket idle timeout;
- maximum line/message size;
- JSON parse failure budget;
- method allowlist;
- authorization attempt rate limit;
- bounded pending request/job/session structures;
- backpressure on output buffers;
- never echo arbitrary user-controlled data into logs without sanitization;
- optional IP ban TTL after clear abusive behavior;
- proxy protocol support only if deployed behind a trusted TCP load balancer.

## 6. Event-bus security

- TLS required across public WAN;
- unique credentials/cert per edge;
- subject permissions restrict edge to publishing its own namespace;
- central consumer credentials read all edge subjects;
- rotate credentials without pool restart where feasible;
- edge ID is configuration-bound, not accepted from miner input.

## 7. Disk spool

Every accepted share acknowledged to a miner must either:

- already be durably queued to the event system, or
- be written to an fsync-capable local spool that will replay.

Implementation tradeoff: acknowledging after a synchronous disk fsync may reduce throughput. A small append-only WAL with batched fsync is acceptable if documented and soak-tested against power-loss semantics.

Never silently drop accepted shares when the control plane is unavailable.

Spool requirements:

- append-only segment files;
- checksums;
- durable cursor/ack tracking;
- replay in original edge sequence order;
- configurable max disk usage;
- emergency behavior before disk-full (stop accepting new work or clearly fail health; do not continue accepting shares that cannot be retained);
- operator alert thresholds.

## 8. Observability

Expose Prometheus-compatible metrics or equivalent:

### Edge

- connected miners;
- shares accepted/rejected/stale/duplicate by reason;
- accepted work units/sec;
- inferred hashrate;
- template age;
- tip height;
- Stratum notify latency;
- share-validation latency;
- block-submit latency/result;
- event-bus publish latency;
- spool bytes/events;
- vardiff distribution;
- process memory/CPU/event-loop lag.

### Accounting

- event ingest rate/lag;
- duplicate events;
- edge sequence gaps;
- DB transaction errors;
- current round work;
- PPLNS calculation duration;
- block states;
- ledger invariant failures;
- payout queue/batch states.

## 9. Alerts

Critical:

- edge has no fresh template;
- edge CKB node not synced;
- event spool near capacity;
- sequence gap persists;
- block candidate failed submission;
- canonical block becomes orphaned;
- ledger conservation assertion failure;
- payout signing/broadcast anomaly;
- payout worker attempts duplicate reservation;
- payout wallet liquidity below reserved amount.

Warning:

- stale rate exceeds baseline;
- reject rate spike by miner family/region;
- regional latency deterioration;
- vardiff instability;
- DB/event ingest lag.

## 10. Secrets

Separate:

- edge bus credential;
- DB credential;
- API read credential if used;
- payout wallet/signing secret.

The payout key is never copied to:

- edge hosts;
- web/API frontend hosts unless payout worker colocated and isolated;
- CI logs;
- repository `.env` examples.

## 11. Backups

Back up:

- PostgreSQL continuously/daily with tested restore;
- payout wallet/signing material securely and offline;
- active configuration snapshots;
- deployment secrets through the operator's secret manager.

Raw edge spool is transient and need not be backed up if events are already durably in JetStream/PostgreSQL.

## 12. Upgrade strategy

For edge upgrades:

1. deploy to one non-critical/test region;
2. verify miner compatibility and share rates;
3. rolling restart regions;
4. every process restart gets new boot ID;
5. preserve queued/spooled events;
6. ensure job IDs cannot collide across versions/restarts.

Accounting schema migrations must be backward-compatible with at least the currently deployed edge event schema.
