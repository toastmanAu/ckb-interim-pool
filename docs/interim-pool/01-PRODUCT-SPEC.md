# 01 — Product Specification

## 1. Purpose

Build a production-capable interim Nervos CKB mining pool that provides miners with pooled variance reduction while the long-term federated Community Pool is still under development.

The interim system must be straightforward to operate, explain and audit. It deliberately accepts a conventional custodial trust model in exchange for substantially lower implementation complexity.

## 2. User proposition

A miner should be able to:

1. obtain a CKB payout address;
2. choose the geographically nearest Stratum endpoint;
3. configure `CKB_ADDRESS.WORKER` as the miner username;
4. begin hashing without creating an account;
5. see worker status, estimated hashrate, accepted/rejected/stale shares, current difficulty and last share;
6. see pool hashrate, effort, blocks found and block status;
7. see estimated/immature/confirmed/pending-paid/paid balances;
8. receive automatic CKB payouts once policy thresholds are met.

## 3. v1 functional scope

### 3.1 Mining

- CKB Eaglesong only.
- Stratum v1 endpoint compatible with the miner behavior already supported by `ckb-stratum-proxy`, including Bitmain K7/GodMiner handling.
- Multi-miner server rather than single-miner solo semantics.
- Per-connection extranonce/session handling.
- Per-worker vardiff.
- Local share validation.
- Network-target detection and immediate local `submit_block`.
- Job invalidation/new-tip handling.
- Duplicate share detection.
- Stale share classification.
- Ban/rate-limit protections for abusive clients.

### 3.2 Accounting

- Difficulty-weighted accepted shares.
- PPLNS triggered by a pool block.
- Pool fee configurable in basis points.
- Immutable block allocation snapshot after finalization.
- Explicit accounting ledger rather than mutating only a single balance column.
- Idempotent processing of duplicated edge events.
- Ability to rebuild derived balances from the ledger.

### 3.3 Blocks

Track at minimum:

- candidate discovered;
- submission attempted;
- node accepted/rejected response;
- canonical block hash/height;
- orphan/stale status;
- immature;
- mature/creditable;
- allocation finalized;
- paid or partially paid.

The system must never credit a block merely because a network-target share was found. Credit only after the block is confirmed as canonical and reaches the configured maturity criterion.

### 3.4 Payouts

- CKB native payouts only.
- Dedicated payout worker with no inbound public network port.
- Pool payout keys held only by the payout service/secure signer environment.
- Transaction construction uses integer shannons.
- Batching where practical.
- Configurable minimum payout.
- Explicit transaction fee accounting.
- Retry-safe transaction state machine.
- Never send the same payable ledger amount twice.

### 3.5 Dashboard/API

Public pages/API should expose:

- pool status;
- pool hashrate estimates over multiple windows;
- active miners/workers;
- current network tip/epoch/difficulty where available;
- blocks and status;
- pool effort for current and historical rounds;
- miner page by CKB address;
- worker table;
- balances;
- payout history;
- pool fee and payout policy;
- regional endpoint status.

Do not expose miner IP addresses publicly.

## 4. Explicit non-goals for interim v1

- Non-custodial settlement.
- Custom CKB lock scripts.
- Sparse Merkle Tree balance commitment.
- Operator quorum or threshold signatures.
- Community/federated operator enrollment.
- Uptime-weighted operator fee splitting.
- PPS, PPS+, FPPS or pool-financed variance products.
- Multi-coin mining.
- Profit switching.
- Exchange trading/conversion.
- Fiat accounting.
- User/password accounts.

## 5. Correctness principles

1. A submitted share is either accepted exactly once for accounting or rejected with a reason.
2. Duplicate transport delivery must not duplicate credited work.
3. A pool block's PPLNS allocation is deterministic from the ordered accepted-share history plus configuration snapshot.
4. A mature reward cannot be distributed before the corresponding block is canonical and creditable.
5. Money movement is ledger-derived and auditable.
6. Public edge failure must not corrupt balances.
7. Central API/dashboard failure must not prevent an edge from validating shares or submitting a found block.
8. Central control-plane outages should degrade to bounded buffering, not silent share loss.

## 6. Operational success criteria

A launch candidate must demonstrate:

- sustained K7 mining with expected share flow and no unexplained reject spikes;
- multiple simultaneous miners/workers;
- vardiff convergence;
- deterministic share validation against known vectors;
- correct testnet block detection/submission;
- correct PPLNS allocations under synthetic and real testnet rounds;
- safe restart of every service without double-credit/double-pay;
- control-plane disconnect/reconnect with event replay;
- region loss without accounting corruption;
- payout dry-run and testnet payout execution;
- observability sufficient to diagnose stale/reject/latency problems.
