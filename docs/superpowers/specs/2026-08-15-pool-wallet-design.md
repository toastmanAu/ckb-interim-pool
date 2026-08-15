# pool-wallet — treasury, reconciliation and autonomous payouts

**Status:** design approved 2026-08-15, pending implementation plan
**Scope:** new subsystem (`src/wallet/`), one new service, two new tables

---

## 1. Why

The pool can mine blocks and compute what each miner is owed. It cannot pay
anyone. `src/payout/` was written in August and has never run against real
value: no key, no timer installed, no process. The only payout batches that
ever existed in the database were test fixtures.

Two things forced the design now.

**The pool does not know what it earned.** `block-tracker.js` reads
`reward_shannons` from the cellbase of the block the pool mined. In CKB that
cellbase pays the miner of block N−11 — a stranger. The figure recorded is
someone else's reward. Within an epoch the error is a few hundredths of a CKB
and invisible; across an epoch boundary it is not. On 2026-08-15 block
20160918 was recorded at 829.5443 CKB against an actual 675.0648 — a 154.48
CKB over-record that would have become a real overpayment the moment a payout
worker existed.

**Income now lands somewhere the pool cannot spend from.** `block_assembler`
was pointed at a phone-held address on 2026-08-15. A payout worker needs
spendable funds; putting a phone wallet's key on a server defeats the point of
it being on a phone.

The wallet service resolves both: it becomes the authority on income actually
received, and it holds a bounded hot float that funds payouts while surplus
sweeps to cold.

### Existing defects this subsumes

| Defect | Location | Resolution |
|---|---|---|
| Reward read from the wrong block's cellbase | `block-tracker.js` | tracker stops extracting reward; wallet writes `treasury_receipts` |
| Cell selection is `order: 'desc'` (newest first) | `ckb-tx-builder.js` | oldest-first selection |
| No cellbase-maturity filter on cell selection | `ckb-tx-builder.js` | maturity filter; a pool wallet's income is *entirely* cellbase outputs |

The third is severe and latent only because the worker has never run: cellbase
outputs are unspendable for 4 epochs, and `desc` ordering preferentially
selects exactly the cells that cannot be spent.

---

## 2. Goals and non-goals

**Goals**

- Be the authority on income actually received, verified against chain
- Pay miners autonomously within bounds the operator sets
- Sweep surplus to cold, never sweeping funds owed to miners
- Log treasury movement so "where did the money go" is answerable afterwards
- Keep the signing key out of any process that parses untrusted input

**Non-goals** (deliberately deferred; none blocks paying one miner tonight)

- Multi-sig or hardware-wallet signing
- Notification channels (phone push, email)
- A second web service or standalone wallet UI
- Multi-currency or non-CKB assets
- chain-pay integration — see §12

---

## 3. Architecture

`pool-wallet` is a long-running process (`src/wallet/main.js`), its own systemd
unit, running as its own user. It is the only process able to read the signing
key.

**Owns**

- The treasury lock, *derived from the key at startup* and never configured, so
  config drift cannot point it at the wrong wallet
- Income reconciliation (§5)
- Payout execution under caps (§6)
- Sweeping surplus to cold (§7)

**Deliberately does not**

- Touch NATS. No edge events, no untrusted parsing. Inputs are Postgres and the
  CKB node's RPC, nothing else.
- Listen on any network port, including loopback. Approvals arrive as database
  rows it polls, so the admin console never calls into the process holding the
  key.
- Decide what miners are *owed*. That stays with accounting's PPLNS and ledger.
  The wallet decides what may be *paid*, a narrower question.

### Why a separate process

`docs/interim-pool/RUNBOOK.md` §10 states that community-run edges "are treated
as untrusted publishers". The accounting service parses their events by design.
If the signing key lived in that process, a deserialization bug in an untrusted
input path would become a drained wallet. Separating them means untrusted input
and key material never share an address space.

This is the same reasoning at the OS layer: the wallet runs as `pool-wallet`,
not the `pool` user that runs accounting, so the key file is unreadable to the
NATS-facing service.

### Failure independence

If the wallet dies, accounting keeps ingesting shares and tracking blocks;
**allocation pauses**, because allocation now depends on verified income.
Nothing is lost and crediting resumes on restart. Pausing is the correct
behaviour: do not credit miners against income that has not been confirmed.

If accounting dies, the wallet continues paying against already-reconciled
income.

### Reuse

`ckb-tx-builder.js` and `payout-worker.js` move under `src/wallet/` and are
reused rather than rewritten — the RFC 0022 sighash_all builder and the
reserve → broadcast → confirm state machine are tested and sound. Cell
selection inside the builder is rewritten (§1). `src/payout/main.js` is
replaced. The cron/timer model is replaced by a tick loop, because caps and
approvals need durable state across time rather than per-invocation state.

---

## 4. Data model

```sql
-- income actually received, attributed to the block that earned it
CREATE TABLE IF NOT EXISTS treasury_receipts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  block_id             uuid NOT NULL UNIQUE REFERENCES blocks(id),
  block_height         bigint NOT NULL,
  payout_block_height  bigint NOT NULL,          -- block_height + 11
  payout_tx_hash       text NOT NULL,
  output_index         integer NOT NULL,
  lock_args            text NOT NULL,            -- which wallet received it
  amount_shannons      numeric(39,0) NOT NULL,
  mature_at_epoch      bigint NOT NULL,
  first_seen_at        timestamptz NOT NULL DEFAULT now(),
  confirmed_at         timestamptz,
  voided_at            timestamptz,              -- set if a reorg invalidates it
  UNIQUE(payout_tx_hash, output_index)
);
CREATE INDEX IF NOT EXISTS treasury_receipts_block_idx  ON treasury_receipts(block_height);
CREATE INDEX IF NOT EXISTS treasury_receipts_conf_idx   ON treasury_receipts(confirmed_at) WHERE voided_at IS NULL;

-- periodic balance log; pure observability
CREATE TABLE IF NOT EXISTS treasury_snapshots (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  taken_at            timestamptz NOT NULL DEFAULT now(),
  lock_args           text NOT NULL,
  total_shannons      numeric(39,0) NOT NULL,
  spendable_shannons  numeric(39,0) NOT NULL,   -- mature cells only
  cell_count          integer NOT NULL,
  owed_shannons       numeric(39,0) NOT NULL    -- sum of miner_confirmed at snapshot time
);
```

`payout_batches.state` gains `HELD`, and the table gains `released_by text` and
`released_at timestamptz`. Full state set:

```
CREATED → RESERVED → BROADCAST → CONFIRMED
                  ↘ HELD → (released) → BROADCAST
                  ↘ ERROR
```

Cold-address trust-on-first-use (§7) is recorded in a single-row table:

```sql
CREATE TABLE IF NOT EXISTS wallet_config (
  id            integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),  -- single row
  cold_address  text NOT NULL,
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  approved_by   text,          -- set when an operator approves a change
  approved_at   timestamptz
);
```

---

## 5. Reconciliation

For each canonical block at height H:

1. **Read our miner lock from block H's own cellbase witness**, never from
   config. The `CellbaseWitness` molecule carries the lock of whoever mined
   that block — self-describing and immune to later config changes.
2. Wait until block H+11 exists and the tip is `POOL_WALLET_CONFIRMATIONS`
   blocks beyond it. Note this depth is unrelated to the 11-block reward delay
   — it is reorg protection on the block that carries the payment, and is
   deliberately not defaulted to 11 so the two are not conflated.
3. Find the cellbase output in H+11 whose lock matches; record amount, tx hash
   and output index.
4. Compute `mature_at_epoch` as H+11's epoch + 4 (CKB cellbase maturity).
5. Mark confirmed once H+11 is deep enough; re-verify the block hash at that
   point and void the receipt if a reorg changed it.

Step 1 is what makes the 2026-08-15 address changeover a non-event: blocks
20152836–20161018 recorded `5ea0977c…`, everything after records `504b2b5f…`,
and each reconciles against the lock it actually used.

### The solvency invariant

A payout batch may spend at most:

```
min(confirmed reconciled income, on-chain mature cell value) − reserved − paid
```

Solvency stops being a property we hope the allocator computed correctly and
becomes a precondition checked before every broadcast.

### Effect on accounting

`block-tracker.js` stops extracting `reward_shannons`; its job narrows to
canonicality and maturity. `allocator.js` reads the confirmed
`treasury_receipts` row for a block and will not allocate until it exists.
The over-record defect becomes structurally impossible rather than fixed once.

---

## 6. Payout execution

**Tick** (default 5 min): reconcile → recover stuck batches → build batch if
eligible → apply caps → confirm broadcasts → consider sweep. A single Postgres
advisory lock prevents concurrent ticks.

### Containment

The wallet can send to exactly two categories of address:

1. `miners.payout_address` for miners with a positive `miner_confirmed`
   balance, capped per miner at what that miner is owed
2. the single configured cold address, for sweeps

No code path constructs any other destination. A bug in batch construction can
misallocate *between miners*; it cannot invent a recipient.

### Caps

| Cap | Env | Behaviour on breach |
|---|---|---|
| Per-batch total | `POOL_WALLET_MAX_BATCH_SHANNONS` | batch → `HELD` |
| Rolling 24h total | `POOL_WALLET_MAX_DAILY_SHANNONS` | batch → `HELD` until window clears |
| Per-miner | — | clamped to owed balance |

The 24h figure is **derived** by summing broadcast batches in the window, never
kept in a counter. A counter is state that can diverge from truth, which is the
defect class that caused the 2026-08-14 incident.

An over-cap batch is **never auto-split** into cap-sized pieces. Splitting
defeats the cap, since whatever can trigger one payout can trigger ten. The cap
binds on the total.

### Approval

A `HELD` batch is released from the admin console, which writes `released_by`
and `released_at`. The wallet picks it up on the next tick. The console never
calls the wallet; the database is the only channel.

### Arming

Broadcasting requires `POOL_WALLET_ARMED=1`. Unarmed, the service reconciles,
logs, snapshots and builds batches but moves no money. A fresh deploy therefore
cannot pay anyone until explicitly armed. `POOL_WALLET_DRY_RUN=1` remains for
building batch documents with no broadcast.

### Fees

The pool bears transaction fees, booked to the existing `tx_fee` ledger
account, rather than deducting them from miner balances.

---

## 7. Sweep

When spendable value exceeds the float:

```
sweep_amount = spendable − float − total_owed_unpaid
```

where `total_owed_unpaid` is the sum of all positive `miner_confirmed` ledger
balances, plus the value of any batch currently `RESERVED`, `HELD` or
`BROADCAST` but not yet `CONFIRMED`.

The third term is load-bearing: **never sweep funds owed to miners**, even when
they sit above the float. Payouts take priority over sweeps in every tick. If
the computed amount is zero or negative, no sweep occurs.

The cold address is validated at startup — bech32/bech32m checksum, mainnet
HRP, decode to a lock, and re-encode round-trip against the configured string.
A typo in a cold address is unrecoverable, so it is checked rather than trusted.

**Trust on first use:** the address is recorded in `wallet_config` on first
run. If configuration later presents a *different* cold address, the wallet
refuses to sweep until an operator approves the change. Config tampering is
otherwise the one way to redirect funds without touching code.

---

## 8. Key handling

- Key file mode 0600, owned by the `pool-wallet` user; unreadable by the `pool`
  user that runs accounting
- Read once at startup; never logged, never written to the database, never
  included in an error message
- systemd: `ProtectSystem=strict`, `ProtectHome=true`, `PrivateTmp=true`,
  `NoNewPrivileges=true`, `MemoryDenyWriteExecute=yes`, `LimitCORE=0`,
  `ReadWritePaths=` scoped to its own state only

**Two fail-to-start assertions:**

1. key file readable, or refuse to start
2. derived address equals `POOL_WALLET_EXPECTED_ADDRESS` when set, or refuse

The second matters more than it appears. A wrong key file does not error — it
operates a *different wallet*, finds no cells, reports a zero balance and pays
nobody while appearing healthy. The startup log prints the derived **address**
(safe to log) so the armed wallet is verifiable at a glance.

---

## 9. Failure modes

| Failure | Behaviour |
|---|---|
| Node RPC unavailable | tick aborts, no state change, retry next tick |
| Indexer empty or lagging | refuse to act — an empty result is missing evidence, not a zero balance |
| Reorg after a receipt is recorded | re-verify at depth; void the receipt if the block changed |
| Died between broadcast and recording | reconcile by `tx_hash` against chain before building any new batch |
| Broadcast rejected by node | batch → `ERROR` with the node's message clamped to 1024 chars, alert, no retry storm |
| Owed exceeds reconciled income | refuse all payouts and alert — the insolvency alarm |
| Two wallet processes | advisory lock; the second exits |
| Cold address changed in config | refuse to sweep pending approval (§7) |

The empty-result rule is an earned lesson: a CKB indexer cursor poisoning
(`after: "0x"`) silently dropped every inbound message in `cemp-sync` on
2026-07-19 because an empty page was read as truth. It is the same shape as the
orphan verdict of 2026-08-14 — absence of evidence treated as evidence.

---

## 10. Operator surface and testing

### Surface

Admin console (`127.0.0.1:8085`, existing token auth and audit) gains treasury
views: balance and spendable, income reconciliation per block, pending and held
batches with a release action, and sweep history. `poolctl wallet status |
receipts | approve <batch> | sweep --dry-run | doctor`.

`poolctl wallet doctor` verifies config, key → address, node reachability,
indexer freshness and cold-address validity, then prints what *would* happen.
Intended to be run before arming.

### Testing, in order of value

1. **Recorded-chain reconciliation fixtures.** Real H/H+11 pairs captured from
   mainnet — *including the 2026-08-15 address changeover* — asserting income
   attributes to the correct lock. Deterministic, free, and pins the component
   most likely to break. Same technique as
   `test/fixtures/won-blocks-mainnet.json`.
2. **Pure-function units.** Cap arithmetic, the sweep formula (especially the
   `− total_owed_unpaid` term), maturity filter, address validation, cold
   address trust-on-first-use.
3. **DB integration** against `pooltest_ci` — state transitions, crash
   recovery, idempotency, concurrent-tick locking.
4. **Dev-chain end-to-end** using the existing `pool-ckb-dev` container and
   `deploy/ckb-dev-test.sh`: mine, reconcile, pay, assert on chain.

Item 4 is the gate for anything money-moving, not the unit suite. The project's
history is unambiguous on this: 224 passing mock tests missed two on-chain
blockers in `subcell`; 56 passing tests were green while every real block
submission was rejected in `proxy-server`. Mock chains do no script validation
and no pool-acceptance checking.

### Deployment

`pool-wallet.service` with `Restart=always`. The service reports
`pool_build_info`, so `deploy/check-stale.sh` covers it. A stale wallet service
is a more serious condition than a stale tracker.

---

## 11. Configuration

| Variable | Default | Purpose |
|---|---|---|
| `POOL_WALLET_KEY` | — | path to the signing key file (required) |
| `POOL_WALLET_EXPECTED_ADDRESS` | unset | fail-to-start assertion on derived address |
| `POOL_WALLET_COLD_ADDRESS` | — | sweep destination (required) |
| `POOL_WALLET_ARMED` | `0` | `1` permits broadcasting |
| `POOL_WALLET_DRY_RUN` | `0` | build batch documents, broadcast nothing |
| `POOL_WALLET_TICK_MS` | `300000` | tick interval |
| `POOL_WALLET_FLOAT_SHANNONS` | `500000000000` | 5,000 CKB hot float |
| `POOL_WALLET_MAX_BATCH_SHANNONS` | `200000000000` | 2,000 CKB per batch |
| `POOL_WALLET_MAX_DAILY_SHANNONS` | `1000000000000` | 10,000 CKB per rolling 24h |
| `POOL_WALLET_CONFIRMATIONS` | `20` | blocks beyond H+11 before a receipt confirms (reorg protection, not the reward delay) |
| `POOL_MIN_PAYOUT_SHANNONS` | `100000000000` | 1,000 CKB minimum payout (existing) |
| `POOL_NODE_RPC`, `POOL_INDEXER_URL`, `POOL_DB_URL` | — | existing conventions |

Defaults are starting points to tune against real volume, not claims about the
right values.

---

## 12. Future: chain-pay integration

Signing and broadcasting stay behind the existing `txBuilder` interface
(`buildBatchTransfer({ items })`), already implemented three ways
(`createDryRunBuilder`, `createCkbCliBuilder`, `createCkbInProcessBuilder`). A
chain-pay backend would be a fourth implementation and would not touch the
reconciler, the caps, the sweep or the state machine.

Not designed further here — noted only to record that the seam exists and
should not be foreclosed.

---

## 13. Slate wipe

Deferred until this subsystem exists, by decision on 2026-08-15. The current
accounting data is pre-production and contains the reward-extraction defect, so
the wipe removes the need for migration logic. It should be specified
separately: which tables are truncated, which are preserved, and how the reset
is recorded so the ledger's first production entry is unambiguous.
