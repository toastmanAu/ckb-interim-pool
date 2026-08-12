# 02 — Architecture

## 1. System topology

```text
                          PUBLIC INTERNET
                               miners
                                 |
                 +---------------+----------------+
                 |               |                |
             AU EDGE          EU EDGE          US EDGE
          pool-edge          pool-edge        pool-edge
          :stratum           :stratum         :stratum
              |                  |                |
        local CKB node      local CKB node    local CKB node
              |                  |                |
              +-------- durable event bus --------+
                                 |
                         CONTROL / ACCOUNTING
                  +--------------+---------------+
                  |                              |
           accounting service               pool API
                  |                              |
               PostgreSQL                    dashboard
                  |
             payout worker
                  |
           private CKB RPC/wallet
```

Additional regions can be added without changing accounting semantics.

## 2. Components

### 2.1 `pool-edge`

Evolution of `ckb-stratum-proxy/solo-proxy.js` into a production multi-miner edge.

Responsibilities:

- Stratum TCP listener;
- miner compatibility branches;
- template polling/new-tip response;
- job registry;
- extranonce/session allocation;
- vardiff;
- Eaglesong share recomputation;
- share target validation;
- network target validation;
- stale/duplicate classification;
- immediate block submission to local CKB node;
- durable publication of accepted/rejected/block events;
- local metrics and health endpoint;
- bounded disk spool when event bus is unavailable.

Not responsible for:

- miner balances;
- PPLNS calculation;
- payout construction;
- wallet keys;
- final block credit decisions.

### 2.2 Event bus

Preferred: NATS JetStream.

Required properties:

- authenticated TLS connections;
- per-edge identity;
- durable stream;
- replay;
- consumer acknowledgements;
- retention sufficient to cover plausible control-plane outage;
- event IDs remain globally unique across restart.

Suggested subjects:

```text
pool.v1.edge.<edge_id>.share
pool.v1.edge.<edge_id>.block_candidate
pool.v1.edge.<edge_id>.block_submit
pool.v1.edge.<edge_id>.session
pool.v1.edge.<edge_id>.health
```

### 2.3 Accounting service

Single authoritative writer for monetary accounting in v1.

Responsibilities:

- consume edge events idempotently;
- maintain accepted-share history;
- track block lifecycle;
- trigger deterministic PPLNS calculation;
- create immutable allocation records;
- post ledger credits/debits;
- expose query services to API;
- queue payouts.

Prefer one logical writer to simplify ordering and auditability. Scale reads separately before attempting multi-writer monetary state.

### 2.4 PostgreSQL

System of record for:

- edge event ingestion status;
- miners/workers;
- shares;
- blocks;
- block allocations;
- ledger entries;
- payout batches/transactions;
- configuration snapshots.

Redis may be used for cache/rate limiting but is never the source of truth for balances.

### 2.5 Payout worker

Private service responsible for constructing, signing and broadcasting CKB payouts.

Requirements:

- no public listener;
- least-privilege DB/API credentials;
- wallet key never logged;
- dry-run mode;
- deterministic batch creation;
- explicit transaction state transitions;
- post-broadcast confirmation monitoring;
- restart-safe idempotency.

### 2.6 API/dashboard

Read-mostly service. It must not be on the critical share-validation path.

## 3. Trust boundaries

### Public edge

Treat miner input as hostile. Edge may be compromised. Therefore central accounting must verify structural event validity and enforce uniqueness/ranges. For v1, the operator controls all edges, so central re-execution of every Eaglesong share is optional for performance, but the event format must preserve enough material to enable sampled/full revalidation later.

### CKB node

Trusted infrastructure. CKB RPC must not be directly Internet-exposed. Bind to localhost/private network and firewall it.

### Control plane

TLS/mTLS or equivalent service authentication. Edge identity must be explicit and immutable in events.

### Payout plane

Highest-trust zone. Separate credentials and host/container permissions from public edge services.

## 4. Availability behavior

### Central API down

Mining continues. Dashboard unavailable/degraded only.

### PostgreSQL down

Edges continue validating shares and spool/publish events. Accounting stops until recovery.

### Event bus down

Edges locally spool accepted-share and block events to disk, with strict maximum disk usage and alerts. Block submission still occurs locally.

### Local CKB node down

Edge stops issuing fresh work and marks itself unhealthy. Existing jobs should be invalidated conservatively. Miner receives reconnect/temporary failure rather than false acceptance of unsubmitable block work.

### Region lost

Other regions continue. GeoDNS/endpoint documentation should provide failover addresses.

## 5. Deployment model

For initial launch, central services can be colocated on one hardened host:

```text
postgres + nats + accounting + api + payout-worker
```

but use separate processes/containers and credentials so they can later split without redesign.

Each region:

```text
pool-edge + CKB full node
```

The edge and CKB node should ideally share a host or low-latency LAN.
