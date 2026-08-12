# 08 — Community Pool Migration Boundary

## 1. Purpose

The interim pool should serve as the production reference implementation for the mining and PPLNS portions of `community-pool`, not a competing code path that must later be discarded.

## 2. Reusable components

Design these as standalone packages/modules:

```text
pool-edge              miner protocol, jobs, vardiff, share validation
pool-share-model       canonical accepted-share/work representation
pool-pplns             pure deterministic PPLNS engine
pool-network           CKB template/block helpers
pool-observability     metrics/event vocabulary
pool-api-types         public DTOs where useful
```

The long-term Community Pool should be able to reuse or port these with minimal semantic change.

## 3. Interim-only components

```text
central-accounting     authoritative DB ingestion
custodial-ledger       off-chain balance ledger
payout-worker          operator-key CKB payouts
central-event-bus      operator-owned share aggregation transport
```

These are expected to be replaced or materially transformed by Community Pool settlement.

## 4. Future replacement map

```text
INTERIM
pool-edge
  -> accepted-share events
  -> central accounting
  -> PPLNS
  -> PostgreSQL ledger
  -> custodial payout worker

COMMUNITY POOL
pool-edge
  -> signed sequence-numbered share batches
  -> aggregator
  -> same/pinned PPLNS semantics
  -> SMT accrual transition
  -> verify-before-sign operators
  -> on-chain treasury/payout lock
```

## 5. Critical compatibility requirement

The accepted-share semantic record should already contain the Community Pool essentials:

- payout address;
- work/difficulty amount;
- timestamp;
- serving edge/operator ID;
- job ID;
- edge sequence;
- enough PoW material for verification/audit.

Interim events do not need operator signatures, but the schema should permit adding:

```text
batch_id
batch_seq
operator_pubkey
batch_signature
```

without redefining what a share means.

## 6. PPLNS engine purity

`pool-pplns` must be a pure deterministic function over explicit inputs.

Conceptual interface:

```ts
allocateBlock({
  rewardShannons,
  feeBps,
  windowMultiplier,
  networkWork,
  orderedShares,
  roundingPolicyVersion
}) -> Allocation
```

No database queries, clocks, network calls or mutable global config inside the core function.

The DB layer is responsible for selecting/ordering the shares; the engine is responsible for computing the allocation.

This allows the Community Pool operator-signer to independently recompute exactly the same result.

## 7. Golden vectors

Create canonical PPLNS vectors in a neutral format such as JSON.

The vectors should ultimately be consumable by:

- interim TypeScript implementation;
- Community Pool TypeScript/Rust components;
- operator signer;
- future audit/conformance tools.

Do not let production PPLNS behavior drift silently when Community Pool development resumes.

## 8. Naming recommendation

Keep the interim implementation clearly labelled, e.g.:

```text
CKB Pool Reference / CKB Interim Pool
```

rather than calling it the Community Pool before the trust-minimized guarantees exist.

The public UI must state that v1 is operator-custodied.
