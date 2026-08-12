# Source Notes

Public references used to align this handoff with the current projects:

1. CKB Stratum Proxy
   - https://github.com/toastmanAu/ckb-stratum-proxy
   - Reviewed 2026-08-12.
   - Current README describes `proxy.js` pool-relay mode and `solo-proxy.js` direct-node mode; K7/GodMiner compatibility; vardiff; `get_block_template`/`submit_block`; target endianness and nonce details.

2. CKB Community Pool
   - https://github.com/toastmanAu/community-pool
   - Reviewed 2026-08-12.
   - Current README describes a federated non-custodial PPLNS target architecture, implemented SMT/core foundations, planned `pool-proxy`, aggregator, signer and federation components, and difficulty-weighted PPLNS.

3. Nervos CKB RPC documentation
   - https://docs.nervos.org/docs/getting-started/rpcs
   - Current docs warn that CKB JSON-RPC is intended for trusted/internal usage and should not be exposed directly to the public Internet.

This package intentionally does not freeze volatile network statistics such as current hashrate, difficulty, reward or fiat price.
