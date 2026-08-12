# 04 — PPLNS, Block Accounting and Payouts

## 1. Accounting model

The interim pool uses difficulty/work-weighted PPLNS.

For a credited pool block, select the accepted-share history ending at the winning share and walk backward until cumulative work reaches the configured window target:

```text
window_target_work = W × network_reference_work
```

where `W` defaults to `2.0` but is configuration, not code.

Each miner receives:

```text
miner_fraction = miner_work_in_window / total_work_in_window
miner_gross = distributable_block_reward × miner_fraction
```

Use exact integer/rational arithmetic and deterministic remainder handling.

## 2. Configuration snapshot

Every block allocation references an immutable pool configuration snapshot containing at least:

- PPLNS `W`;
- fee basis points;
- payout policy version;
- work-unit encoding version;
- network identifier;
- software accounting version.

Changing configuration affects future rounds only according to a documented activation boundary.

## 3. Block lifecycle

Suggested state machine:

```text
CANDIDATE
  -> SUBMITTED
  -> NODE_ACCEPTED
  -> CANONICAL_IMMATURE
  -> MATURE
  -> ALLOCATED
  -> SETTLED_TO_LEDGER
  -> COMPLETE

Failure/alternate states:
  NODE_REJECTED
  ORPHANED
  INVALID
```

State transitions are append-audited.

## 4. Canonicality

After node acceptance:

- verify block by hash/height using trusted node(s);
- continue checking that it remains canonical until maturity;
- if orphaned before credit, mark `ORPHANED` and do not allocate reward;
- never infer canonicality solely from initial `submit_block` success.

## 5. Reward determination

Do not hard-code a nominal block reward.

Determine actual creditable CKB amount from chain data associated with the found/matured block and the operator-controlled cellbase/pool reward output(s), accounting for the CKB reward structure and any applicable maturity rules.

The accounting service must record the exact observed reward in shannons before allocation.

## 6. Fee calculation

Represent fee as integer basis points:

```text
fee = floor(reward * fee_bps / 10_000)
distributable = reward - fee
```

Record pool fee as its own ledger entry/account, not an invisible subtraction.

## 7. Remainders

Because proportional allocation may not divide evenly:

- all final outputs are integer shannons;
- use deterministic floor allocation;
- accumulate remainder into a documented rounding account or assign deterministically by largest remainder method;
- never let rounding create or destroy value;
- assert `sum(miner credits) + pool fee + rounding remainder = reward`.

Recommended: largest-remainder distribution so the full distributable reward is assigned while preserving proportionality.

## 8. PPLNS snapshot immutability

Once a block reaches `ALLOCATED`:

- persist exact ordered share boundary or boundary IDs;
- persist total work;
- persist per-miner work;
- persist all output credits;
- hash the allocation document;
- never recompute historical miner credits under new configuration/software without an explicit migration/reconciliation event.

Provide a CLI to recompute and compare an allocation for audit.

## 9. Ledger

Use double-entry-inspired immutable entries rather than direct balance mutation.

Example account categories:

- `block_reward_pending`;
- `miner_immature:<address>`;
- `miner_confirmed:<address>`;
- `miner_payout_pending:<address>`;
- `miner_paid:<address>`;
- `pool_fee`;
- `tx_fee`;
- `rounding`;
- `adjustment` (administrative, explicit and audited).

At minimum, every monetary mutation has:

- ledger entry ID;
- amount shannons;
- currency `CKB`;
- address/account;
- block ID/payout ID/reference;
- reason/type;
- created timestamp;
- idempotency key.

Derived balances are views/sums over ledger entries.

## 10. Miner balance states

Expose:

- `immature` — allocation attributable to canonical but not yet payout-eligible reward;
- `confirmed` — matured and credited, not yet queued;
- `pending_payout` — reserved in a payout batch;
- `paid` — broadcast/confirmed historical total according to UI definition.

Do not count orphaned candidate rewards in balances.

## 11. Payout selection

Periodic payout worker:

1. obtains advisory/distributed lock so only one payout builder runs;
2. selects miners with `confirmed >= minimum_payout`;
3. reserves exact amounts by creating a payout batch transactionally;
4. builds CKB transaction using spendable pool cells;
5. estimates/includes network fee;
6. dry-runs/validates where available;
7. signs;
8. broadcasts;
9. stores tx hash;
10. monitors confirmation;
11. finalizes ledger state;
12. on failure, retries safely or releases reservation according to state.

## 12. Payout idempotency

A payout item must have a unique semantic key such as:

```text
miner_address + payout_batch_id + reserved_ledger_range
```

Never select already-reserved ledger credits into a second batch.

If a transaction is broadcast and the process crashes before DB update, recovery must search the saved signed tx/hash before constructing a replacement.

## 13. Wallet separation

Recommended operational split:

- block rewards collect to a dedicated pool collection lock/address;
- payout worker spends from controlled payout-capable cells;
- public edge contains only payout destination configuration, never private key material;
- optional periodic sweep from collection to payout wallet may be introduced, but keep the accounting trail explicit.

## 14. Audit commands

Ship operator CLI commands:

```text
poolctl block show <hash>
poolctl block recompute-allocation <hash>
poolctl miner balance <address>
poolctl ledger verify
poolctl payout dry-run
poolctl payout inspect <batch-id>
poolctl events replay-status
```
