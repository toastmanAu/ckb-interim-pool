# Provenance

All files under `src/mining/` and `src/stratum/job-registry.js` are copied
verbatim from the proven `ckb-stratum-proxy` repository, with **no behavior
changes** (only Node require paths adjusted for the new layout).

| File | Upstream source | Proven by |
|------|-----------------|-----------|
| `src/mining/blake2b.js` | ckb-stratum-proxy `blake2b.js` @ 4d57892 | self-test vector (empty input) |
| `src/mining/eaglesong.js` | ckb-stratum-proxy `eaglesong.js` @ 4d57892 | self-test vector |
| `src/mining/ckb-header.js` | ckb-stratum-proxy `ckb-header.js` @ 4d57892 | mainnet fixture round-trip |
| `src/mining/ckb-target.js` | ckb-stratum-proxy `ckb-target.js` @ 4d57892 | characterization tests |
| `src/mining/ckb-merkle.js` | ckb-stratum-proxy `ckb-merkle.js` @ 4d57892 | real mainnet blocks #19804160/#19804274 (+proposals/uncle fixtures) reproduce exact header roots |
| `src/stratum/job-registry.js` | ckb-stratum-proxy `job-registry.js` @ 4d57892 | 18 regression tests incl. stale-job block recovery |
| `test/fixtures/mainnet-*.json` | ckb-stratum-proxy `test/fixtures/` @ 4d57892 | real `get_block_by_number` responses |

The K7/GodMiner protocol behavior documented in `03-STRATUM-AND-SHARES.md`
lived inline in `solo-proxy.js` @ 4d57892. Phase 1 extracts it into
`src/stratum/miner-family.js` and `src/stratum/vardiff.js` **without changing
wire behavior**, then pins it with new regression tests. The extraction delta
from `solo-proxy.js` is tracked in the git history of this repo.

Baseline check (2026-08-12): `node --test test/*.test.js` → 44/44 pass after
the layout move, identical to the upstream baseline run in
`~/ckb-stratum-proxy-upstream` (44/44).
