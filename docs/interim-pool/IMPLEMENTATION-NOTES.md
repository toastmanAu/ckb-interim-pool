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

## Full-stack rehearsal (2026-08-12, live node)

`deploy/stack-rehearsal.sh`: real end-to-end run —
**miner-sim → edge (.105 template) → NATS JetStream → ingest → PostgreSQL →
API/dashboard**. 729 real Eaglesong shares mined against the live mainnet
template in 20s, all ingested exactly once, visible in the API
(`/api/v1/pool`, `/api/v1/miners/:address`). The simulator
(`test/tools/miner-sim.js`) hashes real Eaglesong at the server-assigned
difficulty.

Bugs found and fixed during the rehearsal:
- `accounting/main.js` hardcoded consumer subjects (`pool.v1.edge.>`) and
  crashed if the stream did not exist yet → subjects now configurable via
  `POOL_EVENT_SUBJECTS` + consumer creation retries (edges boot
  independently of central).
- **Silent publish loss**: the publisher's subject was hardcoded to
  `pool.v1.edge.<id>.*`; with a custom stream namespace the messages
  matched no stream and were dropped without error. Subject prefix is now
  configurable (`events.subjectPrefix`) and the JetStream transport throws
  when a publish matches no stream (fail loud, retry — never treat as
  published). The spool keeps such events until they land.

## Phase 9 — deployment hardening

- **mTLS event bus**: `deploy/gen-nats-tls.sh` (CA + server + per-edge +
  ingest client certs, SAN DNS = username), `deploy/nats-server.conf`
  (TLS `verify_and_map` + per-edge publish isolation — edge-<region> can
  publish only `pool.v1.edge.<id>.>`; ingest subscribes to all), transport
  mTLS support (`tls: {caFile, certFile, keyFile}`). Verified live
  (test/nats-tls.integration.test.js): edge-au publish lands, edge-au
  subscription to edge-eu's namespace is denied by the server, ingest reads
  both. NATS 2.10 maps the client cert CN via the SAN DNS entry.
- **systemd units** (`deploy/systemd/`): pool-ingest, pool-api,
  pool-payout.service+timer (hourly), pool-edge@.service (one instance per
  region config) — hardened (NoNewPrivileges, ProtectSystem, memory caps).
- **Metrics + alerts**: ingest now exposes Prometheus /metrics + /health
  (applied/duplicate/invalid/gaps/db_errors/consumed); edge gained
  `vardiff_changes_total` + spool capacity gauges; `deploy/prometheus/`
  scrape configs + alert rules per spec 06 §9 (orphan/conservation/payout
  rules marked Phase 10 — pending a block-state exporter).
- **Backup/restore**: `deploy/backup.sh` (custom-format pg_dump + 30d
  retention), `deploy/restore.sh` (drop+restore with explicit confirmation).
- **Runbook**: `docs/interim-pool/RUNBOOK.md` — startup order, daily checks,
  failure procedures (edge/region, central, bus, node, payout), backup
  drill, upgrades, secrets map, region checklist.
- **Phase 9 gate drills** (automated, both passing against the live stack):
  - `deploy/drill-region-loss.sh` — two edges mine; edge-2 killed; edge-1
    continues; edge-2 restarts (new boot id) + spool replay → 1298 shares
    across both regions in PostgreSQL, zero duplicates.
  - `deploy/drill-central-outage.sh` — NATS stopped mid-mining; shares keep
    flowing into the spool; NATS restarted → all 898 shares exactly once.
  - Bug found by the drills: drill/rehearsal configs must use unique subject
    namespaces or the test server accumulates overlapping streams
    (cleanup now deletes all streams at start of every drill/test).

## Remaining gates (not done in this session — ops/deployment)

- Real K7/GodMiner + Goldshell hardware soak; NerdMiner low-diff path.
- Real multi-host region deployment (drills pass locally; two hosts +
  firewall/NTP verification on real hosts).
- Block-state exporter for the orphan/conservation/payout alerts (Phase 10).
- Real testnet block-to-payout lifecycle; payout dry-run vs real wallet.
- Multi-region drills (two edges, central outage, spool replay together).
- 24h+ soak, restore/replay drills, secrets isolation, alerts, runbook
  (spec 07 §11 launch gates).
- Real K7/GodMiner + Goldshell hardware soak; NerdMiner low-diff path.
- Real testnet block-to-payout lifecycle; payout dry-run vs real wallet.
- Multi-region drills (two edges, central outage, spool replay together).
- 24h+ soak, restore/replay drills, secrets isolation, alerts, runbook
  (spec 07 §11 launch gates).
