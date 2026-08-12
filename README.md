# CKB Interim Pool Engineering Handoff

This package specifies a conventional, operator-custodied Nervos CKB mining pool intended to launch before the federated on-chain Community Pool is ready.

## Goal

Ship a reliable public CKB PPLNS pool quickly by extending the proven `ckb-stratum-proxy` mining path, while deliberately keeping interfaces compatible with the later `community-pool` architecture.

## Core decision

- Centralized accounting and custody for the interim release.
- Multi-region Stratum + local CKB-node edges for low latency.
- Difficulty-weighted PPLNS.
- No custom on-chain payout lock, SMT settlement, operator quorum, federation mesh, or trustless payout mechanism in this interim system.
- All monetary amounts use shannons/integers internally; never floating-point for balances.
- The mining/share engine is designed to migrate into Community Pool later with settlement replaced rather than rewritten.

## Package contents

- `docs/interim-pool/01-PRODUCT-SPEC.md` — scope, behavior, user-facing requirements.
- `docs/interim-pool/02-ARCHITECTURE.md` — services, trust boundaries, edge/control-plane topology.
- `docs/interim-pool/03-STRATUM-AND-SHARES.md` — miner sessions, vardiff, share validation, stale/duplicate handling.
- `docs/interim-pool/04-PPLNS-AND-PAYOUTS.md` — accounting, block lifecycle, maturity, balances and payouts.
- `docs/interim-pool/05-DATA-MODEL-AND-API.md` — PostgreSQL schema and internal/public APIs.
- `docs/interim-pool/06-MULTIREGION-OPS-SECURITY.md` — regional deployment, security, failure handling, observability.
- `docs/interim-pool/07-TEST-AND-ACCEPTANCE.md` — unit/integration/soak/testnet/mainnet acceptance gates.
- `docs/interim-pool/08-COMMUNITY-POOL-MIGRATION.md` — reuse boundary and future migration.
- `docs/interim-pool/09-IMPLEMENTATION-PLAN.md` — phased build sequence for an agent.
- `agent/CODING_AGENT_PROMPT.md` — surgical build prompt.
- `agent/DECISIONS.md` — fixed architectural decisions and non-goals.

## Intended placement

Drop this folder into the root of the working repository. The coding agent should read `agent/CODING_AGENT_PROMPT.md` first, then the numbered specifications in order.

## Upstream references reviewed

- https://github.com/toastmanAu/ckb-stratum-proxy
- https://github.com/toastmanAu/community-pool
- https://docs.nervos.org/docs/getting-started/rpcs

The repository review was performed against the public repository state visible on 2026-08-12.
