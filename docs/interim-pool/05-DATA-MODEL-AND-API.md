# 05 — Data Model and API

## 1. PostgreSQL principles

- Use migrations.
- IDs: UUIDv7/ULID or PostgreSQL UUID.
- Monetary values: `NUMERIC(39,0)` or validated signed 64/128-bit-compatible integer representation sufficient for shannons; never `REAL/DOUBLE`.
- Event sequence fields: `BIGINT`.
- Timestamps: `TIMESTAMPTZ` plus source monotonic/epoch timestamps where needed.
- Add unique constraints for every idempotency boundary.
- Partition or retention-manage high-volume share tables if needed.

## 2. Core tables

### `edges`

```text
id text PK
region text
name text
status text
created_at timestamptz
last_seen_at timestamptz
software_version text
```

### `edge_boots`

```text
boot_id uuid PK
edge_id FK
started_at
ended_at nullable
version
```

### `miners`

```text
id uuid PK
payout_address text UNIQUE
lock_hash nullable
network text
first_seen_at
last_seen_at
```

### `workers`

```text
id uuid PK
miner_id FK
worker_name text
first_seen_at
last_seen_at
UNIQUE(miner_id, worker_name)
```

### `sessions`

```text
id uuid PK
edge_id FK
boot_id FK
worker_id FK
miner_family text
connected_at
disconnected_at
last_share_at
final_accepts bigint
final_rejects bigint
```

### `share_events`

```text
id uuid PK                 -- event_id
edge_id FK
boot_id FK
edge_seq bigint
session_id FK
miner_id FK
worker_id FK
job_id text
template_work_id text
work_units numeric(78,0)
assigned_target bytea/hex
pow_hash bytea/hex
nonce bytea/hex
accepted_at timestamptz
is_block_candidate boolean
created_at timestamptz
UNIQUE(edge_id, boot_id, edge_seq)
UNIQUE(edge_id, boot_id, session_id, job_id, nonce)
```

The second unique key may need adaptation to the exact nonce/job representation.

### `blocks`

```text
id uuid PK
candidate_event_id uuid UNIQUE
edge_id FK
miner_id FK
worker_id FK
height numeric
parent_hash text
block_hash text UNIQUE nullable
job_id text
state text
node_submit_result jsonb
found_at timestamptz
node_accepted_at nullable
matured_at nullable
orphaned_at nullable
reward_shannons numeric(39,0) nullable
config_snapshot_id FK
```

### `config_snapshots`

```text
id uuid PK
active_from timestamptz
pplns_window_num bigint
pplns_window_den bigint
fee_bps integer
work_encoding_version integer
payout_policy_version integer
config_json jsonb
config_hash text UNIQUE
```

### `block_allocations`

```text
id uuid PK
block_id FK UNIQUE
start_share_id uuid
end_share_id uuid
total_work numeric(78,0)
distributable_shannons numeric(39,0)
pool_fee_shannons numeric(39,0)
rounding_shannons numeric(39,0)
allocation_hash text
created_at
```

### `block_allocation_items`

```text
allocation_id FK
miner_id FK
work_units numeric(78,0)
credit_shannons numeric(39,0)
PRIMARY KEY(allocation_id, miner_id)
```

### `ledger_entries`

```text
id uuid PK
account_type text
miner_id nullable
amount_shannons numeric(39,0) -- signed
reference_type text
reference_id uuid/text
idempotency_key text UNIQUE
metadata jsonb
created_at
```

### `payout_batches`

```text
id uuid PK
state text
created_at
built_at nullable
broadcast_at nullable
confirmed_at nullable
tx_hash text UNIQUE nullable
raw_tx_or_ref encrypted/controlled nullable
fee_shannons numeric(39,0) nullable
error text nullable
```

### `payout_items`

```text
id uuid PK
batch_id FK
miner_id FK
amount_shannons numeric(39,0)
state text
UNIQUE(batch_id, miner_id)
```

### `ingested_events`

Optional if `share_events` and other target tables do not themselves provide a universal event-id registry:

```text
event_id uuid PK
schema text
edge_id text
boot_id uuid
edge_seq bigint
received_at
payload_hash text
```

## 3. Indexes

At minimum:

- shares by `accepted_at DESC`;
- shares by `miner_id, accepted_at DESC`;
- shares by `worker_id, accepted_at DESC`;
- shares by `work_units` traversal boundary strategy;
- blocks by `height/state`;
- ledger by `miner_id, created_at`;
- payouts by `state`;
- edge sequence lookup.

For high-volume PPLNS traversal, benchmark whether time-ordered share rows plus cumulative work checkpoints/materialized summaries are required.

## 4. PPLNS performance optimization

Do not prematurely aggregate away raw accepted shares.

Add optional cumulative checkpoints:

```text
share_work_checkpoints
  checkpoint_time/id
  cumulative_work
  last_share_id
```

This permits fast backward-window boundary search while preserving raw shares.

## 5. Internal event schemas

Version every message: `*.v1`.

Required classes:

- accepted share;
- block candidate;
- block submit result;
- edge lifecycle/health;
- optional session connect/disconnect.

Use JSON Schema or TypeScript + generated JSON Schema, checked into repo.

## 6. Public HTTP API v1

Suggested read-only endpoints:

```text
GET /api/v1/pool
GET /api/v1/network
GET /api/v1/edges
GET /api/v1/blocks?limit=&cursor=
GET /api/v1/miners/:address
GET /api/v1/miners/:address/workers
GET /api/v1/miners/:address/shares?window=1h|24h|7d
GET /api/v1/miners/:address/payouts
GET /api/v1/policy
GET /health
GET /ready
```

### `/pool`

Return:

- hashrate estimates 10m/1h/24h;
- active workers/miners;
- round work/effort;
- fee;
- last block;
- pool uptime/status.

### Miner endpoint privacy

The endpoint is address-addressed and intentionally public, like a blockchain explorer/pool account. Do not expose IP, session IDs, internal edge sequence, or security metadata.

## 7. Admin API

Prefer CLI/direct private API instead of exposing broad admin controls over the Internet.

If implemented, bind privately and require strong authentication.

Operations include:

- pause/resume payouts;
- inspect/retry payout batch;
- mark/reconcile exceptional block state;
- activate configuration snapshot;
- replay event range;
- edge disable/quarantine.

Every administrative monetary adjustment must require a reason and create an immutable audit entry.
