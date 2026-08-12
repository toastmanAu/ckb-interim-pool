# Locked Decisions

These decisions are intentionally fixed for the interim pool unless implementation evidence demonstrates a blocker.

1. **Pool model:** conventional custodial pool, not trust-minimized.
2. **Reward model:** difficulty-weighted PPLNS only for v1. No PPS/PPS+/FPPS.
3. **Coin:** CKB only.
4. **Mining protocol:** Stratum v1-compatible behavior inherited from `ckb-stratum-proxy` and extended for multi-miner pool accounting.
5. **Mining edge:** every production region runs its own Stratum edge adjacent to a trusted local CKB full node.
6. **Block submission:** winning blocks are submitted immediately by the edge to its local node; submission must never wait on the central accounting service.
7. **Share acceptance:** share PoW is validated locally at the edge before acceptance.
8. **Accounting authority:** PostgreSQL-backed central accounting service is authoritative for PPLNS, balances, block states and payouts.
9. **Transport:** edges publish durable share/block events to the control plane. NATS JetStream is preferred; Redis Streams is acceptable only if already operationally preferred.
10. **Delivery semantics:** at-least-once event delivery plus database idempotency. Never assume exactly-once transport.
11. **Miner identity:** payout address is the account identity. Worker name is optional and subordinate to the payout address.
12. **Username format:** canonical `CKB_ADDRESS.WORKER`; bare `CKB_ADDRESS` is accepted with a generated/default worker name.
13. **Amounts:** all CKB values are integer shannons represented as `BIGINT`/`bigint`/decimal strings across JSON boundaries.
14. **Difficulty math:** use integer/big-number-safe target calculations. No IEEE-754 comparisons for consensus-sensitive hashes/targets.
15. **PPLNS window:** cumulative accepted share difficulty, not share count. Window target is `W × network_difficulty`; initial default `W = 2.0`, configurable.
16. **Pool fee:** configurable in basis points. Initial recommended configuration 100 bps (1%), but code must not hard-code it.
17. **Payout floor:** configurable. Choose an operational default only in deployment config; do not encode policy into accounting logic.
18. **Block maturity:** derive confirmation/maturity state from CKB node data/configuration; do not rely on a hard-coded wall-clock approximation.
19. **Custody:** block assembler payout points to a dedicated pool hot/collection address or lock controlled by the operator. Payout wallet keys are never present on public Stratum edges.
20. **RPC exposure:** CKB JSON-RPC remains private/trusted-network only. Public miners connect only to Stratum and public HTTP API/dashboard surfaces.
21. **No YiiMP dependency required:** borrowing concepts is allowed, but v1 should not inherit YiiMP unless doing so measurably reduces implementation complexity.
22. **Community Pool compatibility:** share/event/PPLNS code should be isolated so it can later feed signed batches + SMT settlement.
23. **No federation in interim v1:** no operator quorum, Tailscale/Headscale signer mesh, uptime fee protocol, SMT accrual, custom payout lock, or on-chain settlement.
24. **No exchange integration:** payouts are CKB only.
25. **No user registration/password system:** wallet address is the miner account.
