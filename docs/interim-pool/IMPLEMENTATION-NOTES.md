# Implementation Notes — CKB Interim Pool

Phase-by-phase execution record. Every phase: found/reused evidence, what was
built, test/lint commands and results, deviations and blockers.

## Phase 0 — Reconnaissance and preservation

The handoff (`/home/phill/wyltek-pool`) contained only docs + agent prompt.
The proven mining code lives in `~/ckb-stratum-proxy-upstream` (toastmanAu's
`ckb-stratum-proxy` @ `4d57892`). `~/community-pool` consulted for naming/
interfaces only. Proven artifacts reused: `src/mining/{blake2b,eaglesong,
ckb-header,ckb-target,ckb-merkle}.js`, `src/stratum/job-registry.js`,
mainnet block fixtures. Baseline 44/44 tests pass; after layout move 44/44.

Environment: Node v22.22.0, Docker available. No reachable CKB node on the
LAN — live-node verification deferred (mainnet fixtures + upstream-proven
field handling stand in; see Phase 2 blockers).

## Phase 1 — Modularize proven mining primitives

Extracted (no behavior change) from `solo-proxy.js` @ 4d57892:
`src/stratum/miner-family.js` (K7/Goldshell wire behavior) and
`src/stratum/vardiff.js` (injectable clock). Ported all 44 upstream tests;
added 20 tests incl. **differential tests** against the real upstream module
(200 randomized vardiff trials, target/endianness/nonce samples). 64/64.

## Phase 2 — `pool-edge`

Built: `src/common/ids.js` (UUIDv7, boot id, wire job ids), `username.js`
(bech32/bech32m + RFC 0021 CKB address validation; strict worker charset),
`metrics.js`, `edge/rpc.js`, `edge/template-service.js` (poll + WS push +
watchdog + health), `edge/share-validator.js` (reason codes),
`edge/block-submitter.js` (critical-path submit), `edge/edge-server.js`
(multi-miner: unique per-session extranonce1, duplicate cache, vardiff,
connection/line/JSON/auth limits, write backpressure, idle timeout, events
to injectable sink, /health + /metrics), `edge/edge.js` + `main.js`,
`test/tools/mock-node.js`, `test/tools/mine-share.js`.

CKB verification performed:
- RFC 0021 fetched/verified (payload types, checksums, HRPs `ckb`/`ckt`).
- `diffToTargetLE` granularity floor: diffs < 1e-6 divide by zero (upstream
  code untouched) → config rejects `minDiff < 1e-6`.
- Wire job ids `bootId8 || seq8` (spec 03 §4), registry stays int-keyed.
- Block submission verified end-to-end vs mock node (nonce/number/work_id
  + full header reconstruction from real mainnet fixtures).

8 integration tests over real TCP: K7 subscribe wire shape + unique
extranonce1; authorize (bad address rejected); accepted share event payload
(integer work_units, canonical q-strings, nonce composition, hash recompute);
duplicate/low-diff/unknown/stale classification; Goldshell nested subscribe +
5-field submit; **block discovery → immediate local submit_block → clean
notify → correlated block event**; suggest_difficulty; health/metrics.

Bugs found & fixed: missing `mining.authorize` response; extranonce1
captured at subscribe instead of connection time; mock template rotation;
WS zombie reconnect after shutdown; vectors must be mined against the exact
session `extranonce1` and template (parent_hash changes pow_hash).

86/86 tests; 3 clean consecutive runs.

Deviations (documented): per-session extranonce1 for K7 (upstream used a
fixed prefix — nonce-space collision between two K7s in a pool);
`clean_jobs=true` on parent change per spec 03 §5.4 (upstream always false);
job ids boot-prefixed per spec 03 §4.

Blockers: live CKB node unavailable; real K7 soak pending (ops).

## Phase 3 — Durable event pipeline

- `schemas/*.schema.json` (JSON Schema 2020-12, checked in; additive
  Community Pool batch/signature fields reserved).
- `src/events/validate.js` (Ajv against checked-in schemas),
  `spool.js` (append-only WAL, per-record crc32, multi-boot replay, max-bytes
  fail-closed, batched fsync documented), `publisher.js` (edge-seq ordered,
  at-least-once, backoff on transport failure, invalid-event drop with log),
  `edge-sink.js` (spool+publisher; throws → edge fails closed),
  `nats-transport.js` (JetStream workqueue stream, msgID dedup, per-edge
  subjects), `file-transport.js` (test/single-host fallback).
- Phase 3 gate (test/nats-pipeline.test.js, real NATS 2.10 in docker):
  mining with bus up → `docker stop` → shares keep flowing into the spool →
  `docker start` → new boot replays the old segment → **every event seen
  exactly once** (JetStream workqueue dedup + DB constraints).

Known library quirk: nats.js leaves TCP sockets lingering after `close()`;
the NATS suite runs with `--test-force-exit` (separate npm script).

## Phase 4 — PostgreSQL + ingestion

- `db/migrations/001-init.sql` — full spec-05 schema (numeric(39,0) money,
  numeric(78,0) work, unique constraints at every replay boundary, indexes).
  `002-block-verification.sql` — `template_json`, `block_epoch_json`.
- `src/accounting/db.js` (migration runner), `ingest.js` (idempotent
  processEvent: ingested_events registry gate → edge/boot/miner/worker/
  session upserts → share rows → block candidate/submit correlation;
  seq-gap advisory detection), `accounting/main.js` (JetStream durable
  consumer, ack/nak with requeue).
- Gate (test/accounting.integration.test.js): events through NATS +
  PostgreSQL, **replayed twice → row counts and monetary work unchanged**;
  invalid events write nothing; candidate-share linking works in either
  arrival order.

## Phase 5 — Deterministic PPLNS

- `src/pplns/work-units.js` — canonical integer work: `(2^256−1)/target`.
- `src/pplns/pplns.js` — pure `allocateBlock()`: fee bps, backward window
  (boundary-crossing share included), floor + largest-remainder with
  deterministic tie-break, conservation assertion, allocation hash.
- Golden vectors (spec 08 §7): `test/vectors/pplns-golden.json` — 10 vectors
  (one/two/unequal miners, vardiff, exact boundary, crossing share, huge
  work, fee floor, remainder tie, W-change); generator
  `test/tools/gen-pplns-vectors.js`; the suite asserts regeneration is
  byte-identical. 19 tests incl. 300-trial conservation property test.

## Phase 6 — Block lifecycle and reward crediting

- `src/accounting/block-tracker.js` — canonicality via
  `get_block_by_number(height)` vs candidate hash (formula pinned
  byte-for-byte against a real mainnet block), ORPHANED on mismatch, reward
  = Σ cellbase outputs (chain data, never a constant), maturity at
  tip-epoch ≥ found-epoch + 4 (CELLBASE_MATURITY verified against CKB
  source `spec/src/consensus.rs`).
- `src/accounting/ledger.js` — immutable entries, idempotency keys, derived
  balances, conservation check.
- `src/accounting/allocator.js` — MATURE→ALLOCATED guard (single-writer),
  config snapshot, allocation + items + ledger in one transaction,
  →SETTLED_TO_LEDGER. Tests: conservation, double-allocate no-op, immature
  blocks cannot allocate, orphan detection, reward extraction.

## Phase 7 — Payout worker

- `src/payout/payout-worker.js` — advisory lock, eligibility = confirmed
  balance ≥ floor (net of reservations — bug found where the `> 0` filter
  excluded debits), transactional reservation (CONFIRMED→PENDING_PAYOUT),
  per-miner build/broadcast via TxBuilder, PAID posting, confirmation
  polling, crash recovery (checks on-chain tx before re-sending).
- `src/payout/tx-builder.js` — DryRunBuilder (deterministic, offline) +
  CkbCliBuilder (`ckb-cli wallet transfer`, one recipient per tx — verified
  against ckb-cli source; batch is logical).
- `src/accounting/poolctl.js` — operator CLI (block show/recompute,
  miner balance, ledger verify, payout dry-run/inspect, events status).
- Tests: double-reservation impossible, no double-pay after simulated
  crash, confirmation state machine.

## Phase 8 — Public API + dashboard

- `src/api/api-server.js` — read-only /api/v1 (pool, network, edges, blocks,
  miners/:address [+workers/shares/payouts], policy), /health, /ready;
  no IPs/session/internal metadata exposed.
- `src/api/dashboard.html` — dependency-free responsive dashboard with the
  custodial-model disclaimer (spec 08 §8, 09 Phase 8 task 8).
- Test: pool/miner/policy endpoints against seeded PostgreSQL.

## Test status (2026-08-12)

| Suite | Command | Result |
|---|---|---|
| unit (mining/stratum/events/edge/pplns/username) | `npm test` | 99/99 |
| NATS pipeline gate | `npm run test:nats` (needs `deploy/nats-test.sh`) | 1/1 |
| DB integration (ingest/tracker/allocator/payout/api) | `node --test --test-force-exit test/*.integration.test.js test/block-tracker.test.js test/allocator.test.js test/payout.test.js` (needs `deploy/pg-test.sh`) | 5/5 |

## Live-node verification (2026-08-12, mainnet node at 192.168.68.105:8114)

Performed against the operator's live mainnet node; all consensus-sensitive
assumptions now confirmed on-chain (previously fixture-only):

1. `get_block_template` field shape matches the edge exactly (work_id,
   number, compact_target, current_time, epoch, parent_hash, dao, cellbase,
   transactions, proposals, uncles, extension); live reward at the time:
   61,833,531,560 shannons ≈ 618.34 CKB from the template cellbase.
2. Merkle roots + header serialization verified live: for a real block at
   height 20,134,759, `templateToHeaderFields` reproduces
   transactions_root/proposals_hash/extra_hash exactly, and the full header
   hash formula reproduces the on-chain block hash exactly.
3. WS `new_tip_header` subscription works against the live node (28114):
   a new-tip push → new job with clean=true arrived within one block (~8s).
4. Epoch parse (RFC 0021 layout) consistent with live tip (number/index/
   length all in range; length ≈ 1630, sane for mainnet).
5. **Bug found and fixed (live node): `submit_block` nonce encoding.**
   The node's Uint128 JSON parser (util/jsonrpc-types/src/uints.rs) rejects
   any leading zero nibble after `0x` ("redundant leading zeros"). The
   proven upstream proxy zero-pads the nonce to 32 hex chars —
   ~8.5% of real mainnet blocks (34/400 sampled) have a shorter minimal
   nonce and would have been rejected. `block-submitter.js` now converts to
   minimal hex (`0x` + BigInt(nonce).toString(16)) before submission —
   value-preserving (identical serialized header bytes, pinned by test).

## Remaining gates (not done in this session — ops/deployment)

- Real K7/GodMiner + Goldshell hardware soak; NerdMiner low-diff path.
- Real testnet block-to-payout lifecycle; payout dry-run vs real wallet.
- Multi-region drills (two edges, central outage, spool replay together).
- 24h+ soak, restore/replay drills, secrets isolation, alerts, runbook
  (spec 07 §11 launch gates).
- Real K7/GodMiner + Goldshell hardware soak; NerdMiner low-diff path.
- Real testnet block-to-payout lifecycle; payout dry-run vs real wallet.
- Multi-region drills (two edges, central outage, spool replay together).
- 24h+ soak, restore/replay drills, secrets isolation, alerts, runbook
  (spec 07 §11 launch gates).
