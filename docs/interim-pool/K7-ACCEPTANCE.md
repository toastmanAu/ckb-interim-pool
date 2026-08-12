# K7 Acceptance Session Runbook

Real-hardware gate (spec 07 §6) using the operator's Bitmain K7/GodMiner.
K7 availability: daily 10:00–13:00 (free electricity window). If community
members later point remote machines at the pool, the same edge serves them —
this session validates that path's miner-facing behavior.

## 0. Pre-flight (before 10:00)

```bash
# 1. node sanity — the live mainnet node must be up
curl -s --max-time 4 http://192.168.68.105:8114 -X POST -H 'Content-Type: application/json' \
  -d '{"id":1,"jsonrpc":"2.0","method":"get_tip_header","params":[]}' | head -c 200

# 2. full test suite
npm test && npm run test:nats

# 3. start the acceptance edge
deploy/k7-session.sh deploy/edges/k7-acceptance.json   # run in a terminal
```

The edge listens on `0.0.0.0:3333`. Configure the K7 pool URL to
`stratum+tcp://<edge-ip>:3333`, username
`<your-mainnet-ckb-address>.k7-01`, password anything (ignored).

> The acceptance edge mines real mainnet work with the pool's own collection
> address as payout destination (operator-custodied — see
> `deploy/edges/k7-acceptance.json` `edge.network`). Any block found is
> submitted to the local node immediately and would credit the configured
> payout address after maturity. For a risk-free dry pass first, point the
> node section at a testnet node and use a `ckt1` address instead.

## 1. Session checklist (watch the session log)

| # | Check | Pass criterion |
|---|-------|----------------|
| 1 | Subscribe | K7 receives `[null, <extranonce1>, 8]`; **no subscribe loop** (a loop = the response shape is wrong) |
| 2 | Authorize | `result: true`; username parsed as `<address>.k7-01` |
| 3 | Notify flow | `mining.notify` with a fresh boot-prefixed job id every new tip (~8s), `clean_jobs=true` on parent change |
| 4 | Vardiff convergence | Session diff climbs from the 65536 seed toward the ~network-difficulty target within a few retargets; no oscillation (log shows bounded 0.25x–4x steps) |
| 5 | Share rate | Accepted share rate consistent with configured `targetShareSec=30` per share at the converged diff — i.e. `est hashrate` ≈ K7's real hashrate |
| 6 | Reject reasons | **No unexplained `LOW_DIFFICULTY` spikes**; rejects only at vardiff transitions |
| 7 | Duplicates | Near zero `DUPLICATE` |
| 8 | Stales | Stale ack rate ≈ new-tip rate (each tip change makes in-flight work stale); not more |
| 9 | Reconnect | Kill and restart the edge mid-session; K7 reconnects, gets a new boot id + fresh job, keeps hashing without a subscribe loop |
| 10 | Block path (opportunistic) | If a block is found: `submit_block` result logged, clean=true notify follows, block event written to the spool |
| 11 | Durability | `spool-k7-test/wal-*.log` exists and replays: `node src/accounting/poolctl.js events replay-status` after wiring a DB, or inspect the WAL directly |

## 2. During the session

Watch the live line: `sessions=1 accepted=N rejected=M`. Expected numbers at
K7 scale (≈ 1–2 PH/s, network diff ≈ 5×10^5):

- converged vardiff ≈ network difficulty (each share ≈ 1 block-expected-work);
- ~1–2 accepted shares per 30s per the targetShareSec setting — if shares
  arrive much faster or slower, vardiff converges over 2–3 retargets;
- rejected stays ~0 after convergence.

The 10–13:00 window gives a ~3h session: 30min baseline + reconnect/restart
exercises + optional low-diff soak if a NerdMiner/CPU miner is pointed at
the same edge (validates the mixed-work PPLNS fairness path, spec 07 §6.3).

## 3. After the session (pass gate)

1. `Ctrl-C` the session script → summary line printed (accepted/rejected/
   duplicates/stales/connections).
2. Copy `k7-session-logs/k7-session-*.log` + `k7-samples-*.txt` into
   `docs/interim-pool/k7-session/` for the acceptance record.
3. Confirm every accepted share is durably in the spool export
   (`spool-k7-test/export/export.log`) and — once central accounting is
   wired — visible in PostgreSQL via `poolctl events replay-status`.
4. Record the session in `docs/interim-pool/IMPLEMENTATION-NOTES.md`:
   K7 model/firmware, edge commit hash, vardiff convergence chart, share/
   reject counts, any deviations.

**Gate met** when: no subscribe loop, vardiff converges, share rate matches
configured target, reject spikes absent, restart/reconnect clean, and all
accepted shares survived into the durable store.

## 4. Community miners later

The same edge (or the production region edges) serves remote machines:

- miners use `CKB_ADDRESS.WORKER` usernames; accounts are created implicitly;
- the public API/dashboard (`deploy/docker-compose.yml`) gives them their
  balances/shares without any registration;
- per-IP connection limits in the edge config protect the stratum endpoint;
- publish the endpoint as `au.pool.example:3333` style, keep explicit region
  hostnames (spec 06 §3), and document backup endpoints.
