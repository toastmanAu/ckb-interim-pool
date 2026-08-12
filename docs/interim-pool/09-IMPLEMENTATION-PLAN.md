# 09 — Coding-Agent Implementation Plan

## Phase 0 — Repository reconnaissance and preservation

### Tasks

1. Inspect the local project tree and determine whether this handoff was dropped into `ckb-stratum-proxy`, a new repo, or a monorepo.
2. Locate all existing mining protocol code/tests before editing.
3. Run existing tests and document baseline.
4. Create an implementation branch/worktree if the environment supports it.
5. Do not alter working K7 behavior until regression tests pin it.

### Deliverable

`docs/interim-pool/IMPLEMENTATION-NOTES.md` containing discovered paths, baseline commands and deviations from assumed layout.

## Phase 1 — Modularize proven mining primitives

### Objective

Extract/reuse existing code without changing behavior.

Suggested modules:

```text
src/mining/eaglesong.*
src/mining/ckb-header.*
src/mining/ckb-target.*
src/mining/ckb-merkle.*
src/stratum/miner-family.*
src/stratum/job-registry.*
src/stratum/vardiff.*
```

### Required tests

- existing K7 compatibility;
- target endianness;
- nonce assembly;
- known share validation vectors.

### Gate

No feature work until regression suite passes.

## Phase 2 — Build `pool-edge`

### Tasks

1. Multi-miner Stratum server based on solo proxy.
2. CKB address/worker authorization parser.
3. Unique session/extranonce management.
4. Per-session vardiff.
5. Local full share recomputation.
6. duplicate/stale reason codes.
7. immutable job records + bounded previous jobs.
8. local node block submission.
9. structured logs.
10. metrics/health.
11. edge boot ID + monotonic event sequence.

### Gate

Multiple miner simulators plus real K7 can mine concurrently with correct attribution.

## Phase 3 — Durable event pipeline

### Tasks

1. Define versioned JSON schemas.
2. Add NATS JetStream publisher.
3. Implement local append-only spool/WAL.
4. Publish/replay accepted share events.
5. Publish block candidate/submission events.
6. Authenticate edge to bus.
7. Sequence-gap instrumentation.

### Gate

Disconnect NATS for a test interval, continue mining, reconnect, and prove every accepted event appears exactly once in DB after idempotent replay.

## Phase 4 — PostgreSQL and ingestion service

### Tasks

1. Create migrations for core schema.
2. Build event consumer.
3. Validate schema/version/ranges.
4. Enforce event/edge sequence uniqueness.
5. Upsert miner/worker metadata.
6. Insert accepted shares.
7. Track blocks/submission states.
8. Add cumulative work/checkpoint strategy if benchmarks justify it.

### Gate

Replay full event stream twice; row counts and monetary state remain unchanged.

## Phase 5 — Deterministic PPLNS package

### Tasks

1. Implement canonical integer work representation.
2. Implement pure PPLNS window selection/allocation.
3. Implement fee basis points.
4. Implement deterministic remainder policy.
5. Create golden JSON vectors.
6. Add conservation/property tests.
7. Persist immutable block allocation snapshot/hash.

### Gate

All vectors deterministic across repeated runs and large integer cases. `allocated + fee == reward` exactly.

## Phase 6 — Block lifecycle and reward crediting

### Tasks

1. Poll/observe canonical block state from trusted node.
2. Confirm actual found block hash/height.
3. Detect orphaning.
4. Determine actual reward from chain data rather than constants.
5. Determine maturity from node/chain semantics/configuration.
6. Trigger allocation only once.
7. Post immutable ledger entries.

### Gate

Testnet real block completes candidate -> canonical -> mature -> allocation -> ledger path.

## Phase 7 — Ledger and payout worker

### Tasks

1. Implement immutable ledger + balance views.
2. Implement payout eligibility query.
3. Transactionally reserve payout items.
4. Build CKB batch payout transaction.
5. Dry-run mode.
6. Secure signer/key loading.
7. Broadcast and confirmation state machine.
8. Crash recovery and idempotency tests.
9. Admin inspection CLI.

### Gate

Testnet payout can be interrupted at every major step and resumed without double payment.

## Phase 8 — Public API and dashboard

### Tasks

1. Pool status.
2. Blocks/effort.
3. Miner/address page.
4. Worker stats.
5. balances/payout history.
6. region health.
7. policy page clearly stating custodial model, fee, PPLNS, payout threshold.
8. responsive/mobile-friendly UI.

### Gate

Dashboard failure has zero effect on mining/accounting.

## Phase 9 — Multi-region deployment

### Tasks

1. Container/systemd definitions.
2. AU initial edge.
3. Second-region edge.
4. TLS event bus.
5. private CKB RPC binding/firewalls.
6. NTP/chrony.
7. explicit region hostnames.
8. monitoring/alerts.
9. backup/restore procedure.
10. runbook.

### Gate

Region failure and central-control outage drills pass.

## Phase 10 — Hardening/mainnet launch

### Tasks

- 24h+ synthetic soak;
- 24h+ hardware soak where practical;
- database restore drill;
- event replay drill;
- payout reconciliation drill;
- dependency/security audit;
- rate-limit/DoS tests;
- log secret scan;
- mainnet config review;
- staged hashrate launch.

## Agent execution rules

- Commit or checkpoint after each phase if permitted.
- Keep tests green at each phase boundary.
- Never silently change mining wire protocol.
- Never use floating point for money.
- Do not add federation/SMT/custom lock functionality to this interim scope.
- Prefer small composable packages over one giant server file.
- Any assumption about CKB consensus/RPC must be verified against local node behavior and current official CKB sources before implementation.
- When a failure can cost miner work or funds, fail closed and emit an actionable error/metric.
