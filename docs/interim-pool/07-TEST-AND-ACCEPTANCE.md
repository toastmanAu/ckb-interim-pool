# 07 — Test and Acceptance Plan

## 1. Test philosophy

Mining pool bugs can either lose miner work or lose funds. Treat consensus-sensitive byte handling, share scoring and monetary accounting as high-integrity code.

No production launch based only on UI/manual testing.

## 2. Reuse existing regression coverage

Import/adapt known-good vectors and tests from `ckb-stratum-proxy` for:

- Eaglesong;
- header construction;
- target conversion;
- target endianness;
- K7 nonce assembly;
- K7 subscribe/submit wire shape;
- job registry behavior;
- vardiff baseline behavior.

Any refactor of these paths requires byte-for-byte/vector equivalence first.

## 3. Unit tests

### Share validation

- hash below share target accepted;
- hash above target rejected;
- exact target boundary;
- big-endian comparison;
- malformed nonce;
- K7 full nonce composition;
- alternate supported miner composition;
- stale job;
- unknown job;
- duplicate submit;
- difficulty transition around new job.

### Username/address

- valid mainnet/testnet address according to deployment network;
- wrong network;
- optional worker;
- invalid characters;
- oversized input;
- multiple dots/edge cases.

### PPLNS

Construct canonical vectors covering:

- one miner;
- two equal miners;
- unequal work;
- vardiff shares;
- exact window boundary;
- share crossing the boundary policy;
- very large work values;
- fee calculation;
- integer rounding;
- largest remainder tie rule;
- configuration snapshot change.

Store expected vector outputs in repo.

### Ledger

- reward conservation;
- no negative unintended miner balance;
- duplicate idempotency key;
- allocation applied twice is no-op/error;
- payout reservation applied twice is no-op/error;
- rollback/recovery behavior.

## 4. Property tests / fuzzing

Strongly recommended for:

- target/work conversions;
- PPLNS conservation;
- allocation never exceeds distributable reward;
- allocation order determinism;
- arbitrary duplicate/reordered event delivery;
- parser malformed JSON/Stratum input.

## 5. Integration tests

Bring up containers/processes for:

```text
CKB dev/test node
NATS
PostgreSQL
pool-edge
accounting
API
payout worker (dry-run)
```

Test:

- miner simulator connects/authorizes;
- thousands/millions of shares;
- bus disconnect and replay;
- DB restart;
- edge restart with new boot ID;
- sequence gap detection;
- duplicate event replay;
- PPLNS block trigger;
- block orphan simulation;
- payout batch crash/restart.

## 6. Real hardware acceptance

At minimum:

### Bitmain K7 / GodMiner

- sustained connection;
- no subscribe loop;
- expected vardiff convergence;
- accepted-share rate consistent with configured target;
- no unexplained low-diff rejects;
- reconnect handling;
- worker stats correctly attributed.

### Goldshell-compatible path

Repeat session/submit regression where hardware is available.

### NerdMiner/low-hash path

Validate low-difficulty vardiff and that high-frequency small-work shares do not unfairly dominate PPLNS compared with equivalent total work from ASIC shares.

## 7. Testnet block exercise

Before mainnet:

1. configure dedicated testnet pool payout destination;
2. mine real testnet work;
3. observe real candidate;
4. confirm immediate local node submission;
5. track canonical state;
6. derive actual reward;
7. calculate PPLNS;
8. post ledger;
9. execute testnet payout;
10. reconcile transaction and balances.

Repeat enough times to cover restart and failure cases.

## 8. Multi-region simulation

Run at least two edges with distinct edge IDs and local/dev nodes where practical.

Validate:

- interleaved share ordering by accepted timestamp/tie rule;
- no event-ID collision;
- same miner using multiple regions/workers;
- one edge offline while another continues;
- central outage and both spools replay;
- winning block from either region produces one allocation only.

## 9. Ordering rule

Because distributed edges cannot provide a perfect total order by wall clock, define deterministic central ordering before launch.

Recommended key:

```text
accepted_at_ms, edge_id, edge_boot_id, edge_seq
```

Clock skew must be monitored. Prefer NTP/chrony on every edge. The PPLNS specification must pin the ordering tie-break behavior and tests.

Longer term, Community Pool signed batches may use different sequencing; isolate this policy.

## 10. Load/soak

Target at least 24-hour preproduction soak with synthetic share rates above expected launch peak.

Measure:

- event loop lag;
- memory growth;
- DB size/write rate;
- NATS lag;
- spool behavior;
- PPLNS query duration;
- API response time;
- reject classification consistency.

## 11. Mainnet launch gates

Do not launch until all are true:

- all unit/integration tests green;
- PPLNS golden vectors locked;
- real K7 soak passes;
- testnet block-to-payout lifecycle passes;
- payout dry-run reconciliation passes;
- PostgreSQL restore tested;
- event replay tested;
- secrets isolated;
- CKB RPC not publicly reachable;
- alerts configured;
- operator runbook exists;
- pool fee/min payout/PPLNS window publicly documented.
