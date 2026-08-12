# CODING AGENT PROMPT — CKB Interim Pool

You are implementing a production-oriented interim mining pool for Nervos CKB (Eaglesong). This is a conventional operator-custodied PPLNS pool intended to launch before the separate trust-minimized `community-pool` project is complete.

## READ FIRST

Read these files in order before modifying code:

1. `agent/DECISIONS.md`
2. `docs/interim-pool/01-PRODUCT-SPEC.md`
3. `docs/interim-pool/02-ARCHITECTURE.md`
4. `docs/interim-pool/03-STRATUM-AND-SHARES.md`
5. `docs/interim-pool/04-PPLNS-AND-PAYOUTS.md`
6. `docs/interim-pool/05-DATA-MODEL-AND-API.md`
7. `docs/interim-pool/06-MULTIREGION-OPS-SECURITY.md`
8. `docs/interim-pool/07-TEST-AND-ACCEPTANCE.md`
9. `docs/interim-pool/08-COMMUNITY-POOL-MIGRATION.md`
10. `docs/interim-pool/09-IMPLEMENTATION-PLAN.md`

Then inspect the entire existing repository. Treat working code and tests in `ckb-stratum-proxy`-derived components as valuable production evidence.

## PRIMARY OBJECTIVE

Turn the existing proven CKB solo Stratum path into a multi-miner public pool with:

- geographically distributable Stratum edges;
- local CKB node per edge;
- local Eaglesong validation;
- vardiff;
- durable share events;
- centralized PostgreSQL accounting;
- difficulty/work-weighted PPLNS;
- canonical block/maturity tracking;
- immutable ledger;
- automatic CKB payouts;
- pool/miner dashboard and API.

## HARD ARCHITECTURAL CONSTRAINTS

### Preserve mining compatibility

The existing proxy has known working behavior for Bitmain K7/GodMiner and other CKB miners. Do not casually rewrite this protocol path. First pin behavior with regression tests, then refactor behind those tests.

Preserve at minimum:

- K7 subscription response behavior;
- K7 16-byte nonce composition;
- miner-specific target endianness;
- K7 3-field `mining.submit`;
- big-endian consensus comparison for Eaglesong hashes;
- existing vardiff behavior unless a tested correction is required.

### Critical-path rule

A winning share must be validated and submitted to the edge's LOCAL trusted CKB node immediately. Never wait for PostgreSQL, NATS, the website or central accounting before attempting `submit_block`.

### Accepted-share durability

Once the edge tells a miner a share is accepted, the share must be durably retained either by the event system or local spool/WAL. A central outage must not silently lose accepted shares.

### Accounting

Use deterministic integer/exact work units. Never sum JavaScript floating-point difficulty for PPLNS. Never use floating point for CKB money.

All CKB monetary values are integer shannons.

### Delivery semantics

Assume at-least-once event delivery. Enforce idempotency with immutable event IDs, edge boot IDs, monotonic edge sequences and database unique constraints.

### PPLNS

Implement difficulty/work-weighted PPLNS as a pure deterministic package. Default window multiplier may be 2.0 in deployment config, but it must be configurable. Pool fee uses basis points.

Create checked-in golden JSON vectors and conservation/property tests.

### Custody

This interim release is explicitly custodial. Do NOT implement:

- SMT balance commitments;
- custom payout lock;
- M-of-N operators;
- federation mesh;
- signed share batches as a consensus requirement;
- uptime fee distribution;
- on-chain settlement state machine.

Keep interfaces compatible with adding those later.

### Security

- CKB RPC is private only.
- Payout private keys never exist on Stratum edge hosts.
- Public dashboard is not on the mining critical path.
- Miner-supplied JSON/strings are hostile input.
- Use bounded buffers/collections and rate limits.

## EXPECTED COMPONENTS

Adapt names to the repository, but target logical separation equivalent to:

```text
packages/pool-edge
packages/pool-share-model
packages/pool-pplns
packages/pool-accounting
packages/pool-api
packages/pool-payout
packages/pool-common
schemas/
deploy/
tests/
```

If this is not a monorepo, use corresponding `src/` modules. Do not reorganize the repository unnecessarily merely to match this example.

## IMPLEMENTATION ORDER

Follow `09-IMPLEMENTATION-PLAN.md` phase by phase. Do not jump to the dashboard before mining/accounting correctness is established.

For each phase:

1. state what existing code you found and will reuse;
2. write/extend tests first for consensus-sensitive or monetary behavior;
3. implement the smallest coherent change;
4. run relevant tests/lint/typecheck;
5. document commands/results in `docs/interim-pool/IMPLEMENTATION-NOTES.md`;
6. continue to the next phase only when the current gate is satisfied or record the precise blocker.

Do not stop to ask broad design questions already answered by the specification. Make conservative implementation choices and record them.

## CKB-SPECIFIC VERIFICATION REQUIREMENT

Before implementing assumptions involving CKB RPC fields, block-template layout, reward extraction, cellbase maturity, transaction construction or address/script behavior, verify them against:

- the local installed/running CKB node behavior where available;
- current official Nervos CKB docs/source;
- existing working repository code/tests.

Never hard-code a block reward or approximate maturity time.

## DEFINITION OF DONE FOR V1

V1 is complete only when all of the following work end-to-end:

```text
K7/compatible miner
  -> regional pool-edge
  -> valid vardiff shares
  -> durable event stream
  -> PostgreSQL
  -> deterministic PPLNS
  -> found block tracked canonical/mature
  -> immutable miner ledger credit
  -> payout batch
  -> signed/broadcast CKB payout
  -> miner dashboard reflects resulting state
```

and the failure/replay tests in `07-TEST-AND-ACCEPTANCE.md` pass.

## IMPORTANT QUALITY BAR

This software handles other miners' work and funds. Prefer correctness, auditability and deterministic behavior over cleverness. Do not mask inconsistencies with retries or approximate arithmetic. Every reject reason, block state and monetary transition should be explainable after the fact from logs/database state.
