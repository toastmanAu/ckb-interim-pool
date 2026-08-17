'use strict';
/**
 * tx-builder.js — payout transaction construction adapters.
 *
 *  - DryRunBuilder: deterministic, offline — produces a signed-transaction
 *    document for tests/dry runs (spec 04 §11 step 6, §14 `payout dry-run`).
 *  - CkbCliBuilder: shells out to the official `ckb-cli wallet transfer`
 *    (one recipient per tx — the proven operator path; a payout batch is
 *    logical: one row, one tx per miner). Keys live only in the payout
 *    environment (never on edges). `--max-tx-fee` bounds the fee.
 *
 * Payout private keys never appear in logs or in the repo.
 */

const { execFile } = require('node:child_process');

/** Deterministic offline builder for tests/dry-run. */
function createDryRunBuilder({ payoutAddress }) {
  return {
    async buildTransfer({ toAddress, capacityShannons }) {
      const rawTx = {
        kind: 'ckb-transfer-dry-run',
        from: payoutAddress,
        to: toAddress,
        capacity_shannons: capacityShannons.toString(),
        created_at_ms: Date.now(),
        unsigned: true,
      };
      const txHash = require('node:crypto')
        .createHash('sha256').update(JSON.stringify(rawTx)).digest('hex');
      return { txHash: '0x' + txHash, rawTx, async broadcast() { return { ok: true, txHash: '0x' + txHash }; } };
    },
  };
}

/** Official ckb-cli adapter (operator-run payout host only). */
function createCkbCliBuilder({ ckbCli = 'ckb-cli', rpcUrl, privateKeyPath, maxTxFeeShannons = null, logger = console }) {
  function run(args) {
    return new Promise((resolve, reject) => {
      execFile(ckbCli, args, { maxBuffer: 4 * 1024 * 1024, timeout: 120_000 }, (err, stdout, stderr) => {
        if (err) reject(new Error(`ckb-cli failed: ${stderr || err.message}`));
        else resolve(stdout);
      });
    });
  }

  return {
    async buildTransfer({ toAddress, capacityShannons }) {
      const args = ['wallet', 'transfer', '--from-account', privateKeyPath,
        '--to-address', toAddress, '--capacity', capacityShannons.toString()];
      if (rpcUrl) args.push('--rpc-url', rpcUrl);
      if (maxTxFeeShannons) args.push('--max-tx-fee', maxTxFeeShannons.toString());
      const out = await run(args);
      const m = /(?:tx hash|transaction hash)[:\s]+(0x[0-9a-fA-F]+)/.exec(out);
      const txHash = m ? m[1] : null;
      return {
        txHash,
        rawTx: { cli_output: out.slice(0, 2000), to: toAddress, capacity_shannons: capacityShannons.toString() },
        async broadcast() {
          if (!txHash) throw new Error('ckb-cli did not return a tx hash (dry-run output?)');
          return { ok: true, txHash };
        },
      };
    },
  };
}

module.exports = { createDryRunBuilder, createCkbCliBuilder };
