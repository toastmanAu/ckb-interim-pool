# 03 — Stratum and Share Processing Specification

## 1. Compatibility baseline

Preserve the known-good behavior in `ckb-stratum-proxy`, particularly:

- Bitmain K7 / GodMiner subscription tuple requirements;
- 16-byte Eaglesong nonce composition rules;
- miner-specific target endianness behavior;
- 3-field K7 `mining.submit` handling;
- big-endian consensus interpretation of Eaglesong hash;
- Goldshell/session-resume compatibility where currently supported;
- existing target/difficulty helpers and regression tests.

Refactor only behind tests. Do not rewrite working miner protocol behavior for style reasons.

## 2. Miner identity

Canonical username:

```text
<ckb-address>[.<worker-name>]
```

Rules:

- validate CKB address/network before authorization;
- reject malformed or wrong-network payout addresses;
- worker name is optional;
- normalize worker names to a bounded safe character set;
- do not normalize/alter the payout address in a way that changes meaning;
- cap username and worker lengths to avoid memory/log abuse;
- password is ignored except for optional future static token functionality.

The payout address is the account identity. Multiple workers may map to one address.

## 3. Sessions

Each TCP session receives:

- `session_id` UUID/ULID;
- `edge_id`;
- remote IP internally;
- user-agent/miner-family classification;
- unique extranonce prefix;
- current share difficulty;
- accepted/rejected/stale/duplicate counters;
- last share timestamp;
- bounded duplicate-share cache.

Session IDs must never be reused after process restart.

## 4. Job IDs

Job IDs must be globally distinguishable enough for diagnostics and idempotency.

Recommended logical fields:

```text
edge_id | edge_boot_id | monotonic_job_seq | template_work_id
```

Wire encoding can be compact/hashed, but the server must retain the mapping.

A restart creates a new `edge_boot_id`.

## 5. New-tip/template flow

1. Read trusted local node tip/template.
2. Detect new parent/tip or materially changed work template.
3. Create immutable internal job record.
4. Broadcast `mining.notify`.
5. Set `clean_jobs=true` when parent/tip change invalidates prior work.
6. Retain a small bounded prior-job set so late submissions can be classified as stale rather than unknown.

Prefer rapid polling/subscription mechanisms supported by the existing implementation; correctness must not depend on a public RPC provider.

## 6. Vardiff

Retain the current configurable controls:

- target share seconds;
- retarget interval;
- variance tolerance;
- min difficulty;
- max difficulty;
- optional initial difficulty.

Additional requirements:

- difficulty changes apply prospectively to a clearly identified job boundary;
- store `assigned_difficulty` with each accepted share;
- avoid oscillation by using bounded adjustment factors and minimum sample counts;
- reset or carefully seed estimator after long idle gaps;
- provide fixed-difficulty override syntax/config only if needed for debugging, not as v1 public complexity.

## 7. Share validation order

For each `mining.submit`:

1. parse protocol shape by miner family;
2. verify authorization/session;
3. resolve job ID;
4. classify expired/unknown job;
5. reconstruct full Eaglesong nonce exactly as required by that miner family;
6. construct/reconstruct header bytes from immutable job data;
7. compute Eaglesong PoW hash;
8. compare against assigned share target;
9. check duplicate key;
10. classify accepted share;
11. independently compare against network target;
12. if network target met, construct candidate block and submit immediately to local node;
13. emit durable events.

Do not mark a share accepted before the PoW comparison succeeds.

## 8. Duplicate key

Duplicate accounting protection must exist at two layers.

### Edge duplicate key

Suggested:

```text
hash(edge_boot_id || session_id || job_id || full_nonce)
```

Reject repeats within the active/prior-job window.

### Central event ID

Each event carries an immutable UUIDv7/ULID plus edge sequence number. Database unique constraints guarantee replay does not duplicate accounting.

## 9. Stales

Distinguish:

- `STALE_PREV_TIP` — valid work for an obsolete parent;
- `STALE_JOB_EXPIRED` — valid historical job outside acceptance window;
- `UNKNOWN_JOB` — cannot resolve job;
- `LOW_DIFFICULTY` — valid hash but not assigned target;
- `DUPLICATE`;
- `BAD_NONCE_FORMAT`;
- `BAD_PROTOCOL`;
- `UNAUTHORIZED`;
- `INTERNAL_ERROR`.

Stale shares do not enter PPLNS in v1. Store aggregate reject metrics; storing all rejected share rows is optional and should be sampled/retention-bounded to avoid abuse.

## 10. Accepted-share event

Canonical semantic payload:

```json
{
  "schema": "pool.share.accepted.v1",
  "event_id": "...",
  "edge_id": "au-adelaide-01",
  "edge_boot_id": "...",
  "edge_seq": "123456",
  "session_id": "...",
  "payout_address": "ckb1...",
  "worker": "k7-01",
  "job_id": "...",
  "template_work_id": "...",
  "share_difficulty": "12345.6789",
  "share_difficulty_q": "integer canonical fixed-point form",
  "network_difficulty_q": "...",
  "pow_hash": "0x...",
  "nonce": "0x...",
  "header_hash_or_header_ref": "0x...",
  "accepted_at_ms": 0,
  "is_block_candidate": false
}
```

Difficulty must have a canonical non-floating representation for accounting. Recommended implementation: fixed-point integer difficulty units or exact rational/target-derived work units.

## 11. Preferred accounting unit: work, not float difficulty

To avoid cross-language rounding ambiguity, internally score shares using an integer `work_units` representation derived deterministically from the target/difficulty math. The public UI may display decimal difficulty.

The PPLNS engine should sum `work_units`, not JavaScript floating-point `difficulty` values.

If exact integer work derivation is inconvenient during the first implementation, use arbitrary-precision decimal with a fixed canonical scale and lock it with test vectors before production.

## 12. Block candidate event

Must include enough information to correlate:

- winning share event;
- miner/worker;
- job/template;
- candidate block hash;
- expected height/parent;
- node submission result;
- local timestamp/latency.

Block submission is synchronous to local node, event publication is not.
