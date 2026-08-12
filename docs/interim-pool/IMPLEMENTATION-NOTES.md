# Implementation Notes — CKB Interim Pool

Phase-by-phase execution record. Every phase: found/reused evidence, what was
built, test/lint commands and results, deviations and blockers.

## Phase 0 — Reconnaissance and preservation

### Discovered layout

The handoff (`/home/phill/wyltek-pool`) contained only docs + agent prompt.
The proven mining code lives in `~/ckb-stratum-proxy-upstream` (toastmanAu's
`ckb-stratum-proxy` @ commit `4d57892`, "docs: pool-passthrough mode design
spec"), which is a copy of the working repo with tests. `~/community-pool`
holds the trust-minimized reference architecture (schemata/`pool.mol` etc.)
— consulted for naming/interfaces only.

Key proven artifacts reused:

| File | Role |
|---|---|
| `src/mining/blake2b.js` | CKB personalization blake2b-256 (self-test vector) |
| `src/mining/eaglesong.js` | Eaglesong PoW (self-test vector) |
| `src/mining/ckb-header.js` | raw header serialization + pow_hash |
| `src/mining/ckb-target.js` | compact→target LE, diff→target LE, meetsTargetLE |
| `src/mining/ckb-merkle.js` | molecule encode + CBMT roots; verified against real mainnet blocks |
| `src/stratum/job-registry.js` | bounded job snapshots + evaluateShare/shareDecision |
| `test/fixtures/mainnet-*.json` | real `get_block_by_number` responses (#19804160, #19804274, proposals, uncle) |

Baseline: upstream `node --test` = 44/44 pass. After layout move: 44/44 pass.

### Environment

- Node v22.22.0; Docker available (postgres/nats will run as containers for
  integration tests in Phases 3–4).
- No reachable CKB node on the LAN (checked .80/.91/.102:8114) — live-node
  verification of RPC fields is **deferred until a node is available**;
  mainnet block fixtures + upstream-proven field handling stand in.
- Git initialized; baseline docs committed as `e088b3e`.

### Blockers / notes

- CKB address format verified against RFC 0021 (see Phase 2 §username):
  HRP `ckb`/`ckt`, payload 0x00 full (bech32m), 0x01 short (bech32),
  0x02/0x04 deprecated (bech32). RFC 0029 path is a stale link; 0021 is
  the current RF-0021.

## Phase 1 — Modularize proven mining primitives

### Found and reused

`solo-proxy.js` @ 4d57892 contained the K7/GodMiner + Goldshell protocol
behavior inline. Extracted **without behavior change** into:

- `src/stratum/miner-family.js` — UA classification, subscribe responses,
  notify endianness (BE for K7), nonce composition, vardiff wire messages.
- `src/stratum/vardiff.js` — `checkVardiff` semantics with injectable clock.

### Tests

- Ported all 44 upstream tests into `test/`.
- New `test/miner-family.test.js` (+20 tests):
  - K7 subscribe 3-tuple `[null, extranonce1, 8]`; Goldshell nested tuple.
  - K7 BE target on the wire; LE for others; `leToBe` round-trip.
  - K7 full nonce = `extranonce1 || n8` (16 bytes); others zero-padded.
  - vardiff convergence (fast→raise, slow→lower, tolerance, clamps,
    suggest_difficulty, K7 seed, window reset).
  - **Differential tests** that transcribe the upstream inline logic and
    (when `~/ckb-stratum-proxy-upstream` exists) diff against the real
    upstream modules — 200 randomized vardiff trials + target/endianness/
    nonce samples. Guards future drift.

### Result

64/64 tests pass (`node --test test/*.test.js`).

### Deviations

None for wire behavior. `buildNotifyFor`/job ids gained a `wireJobId` field
(see Phase 2) but the raw wire shape is unchanged.

## Phase 2 — `pool-edge`

### Built

- `src/common/ids.js` — UUIDv7, per-boot edge sequence, boot-prefixed wire
  job ids, per-session extranonce1.
- `src/stratum/username.js` — bech32/bech32m (BIP-173/350) + RFC 0021 CKB
  address validation; `CKB_ADDRESS[.WORKER]` parsing with strict worker
  charset (reject, don't rename) and length caps.
- `src/common/metrics.js` — counters/gauges + Prometheus text.
- `src/edge/rpc.js` — CKB JSON-RPC client (upstream timeout/error shape).
- `src/edge/template-service.js` — polling + new_tip_header WS push +
  watchdog + node health; immutable job snapshots with wire job ids.
- `src/edge/share-validator.js` — share evaluation with pool reason codes
  (LOW_DIFFICULTY / STALE_PREV_TIP / UNKNOWN_JOB / BAD_NONCE_FORMAT / …).
- `src/edge/block-submitter.js` — immediate local `submit_block`
  (critical path; never waits on central services).
- `src/edge/edge-server.js` — multi-miner Stratum server: per-session
  extranonce1, K7/Goldshell branches, duplicate cache (bounded), vardiff,
  connection/line/JSON/auth limits, write backpressure, idle timeout,
  canonical share/block events to an injectable sink, /health + /metrics.
- `src/edge/edge.js` + `main.js` — composition root and entry point.
- `test/tools/mock-node.js` — fake CKB node (HTTP RPC + WS) for tests.
- `test/tools/mine-share.js` — deterministic nonce search for test vectors.

### Verification performed (CKB-specific)

- RFC 0021 fetched and verified: payload types, checksum variants,
  HRPs `ckb`/`ckt`, no length limit (we still cap at 256 chars).
- `diffToTargetLE` granularity floor found: diffs < 1e-6 round to zero and
  divide by zero (proven upstream code, **not modified**). Config loader now
  rejects `minDiff < 1e-6`.
- Job ids: wire ids are `bootId8 || seq8` (globally distinguishable across
  restarts per spec 03 §4); registry stays int-keyed (proven module
  untouched); resolution parses the trailing 8 hex chars.
- Block submission path verified end-to-end against the mock node: the
  submitted block's `header.nonce`, `number`, `work_id` and full header
  reconstruction (real mainnet fixtures) match.

### Tests

`test/edge.integration.test.js` (+8 tests, real TCP): K7 subscribe wire
shape + unique extranonce1 per session; authorize (bad address rejected /
good accepted); accepted share with full event payload (work_units integer,
canonical q-strings, nonce composition, hash recomputation); duplicate
reject; low-diff reject; unknown-job ack; Goldshell nested subscribe +
5-field submit; block discovery → immediate local submit_block → clean
notify after find → block event correlation; stale share acked-but-not-
credited; suggest_difficulty; health/metrics endpoints.

Deterministic vectors: share `n8=…0704` (powHash `3b9780…`), block
`n8=…009b` (powHash `af5752…`, easy target template) — mined offline,
verified at generation and asserted in tests.

### Bugs found and fixed during implementation

1. `mining.authorize` response was never sent (upstream sends
   `{id, result:true}`) — miner would hang after auth.
2. Per-session extranonce1 used a shared counter captured at subscribe-time
   instead of connection-time (nonce-space collision between two K7s).
3. Mock node never rotated templates on `pushNewTip`.
4. WS reconnect could zombie-loop after shutdown (stopped flag added).
5. Vectors must be mined against the exact session `extranonce1` (K7
   nonce = en1 || n8) and the exact template (parent_hash changes pow_hash).

### Result

86/86 tests pass; 3 consecutive full-suite runs exit cleanly.

### Blockers

- No live CKB node available on the LAN to confirm `get_block_template`
  field behavior against a real node; all behavior pinned via real mainnet
  block fixtures (byte-for-byte header reconstruction) + upstream-proven
  field handling. Re-verify against a live node before mainnet (gate G2).
- Real K7 hardware soak still required (ops phase).

## Phase 3 — Durable event pipeline (IN PROGRESS)

(notes appended as implemented)
