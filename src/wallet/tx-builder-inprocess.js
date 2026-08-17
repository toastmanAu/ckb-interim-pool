'use strict';
/**
 * ckb-in-process.js — payout TxBuilder adapter over the self-contained
 * CKB transaction builder (src/wallet/tx-builder.js).
 *
 * The batch path produces ONE signed transaction for the whole payout batch
 * (spec 04 §11). Private keys are read from a file on the payout host only
 * and never logged.
 */

const fs = require('node:fs');
const { buildAndSendBatchPayout } = require('./ckb-tx-builder.js');

function createCkbInProcessBuilder({ rpcUrl, indexerUrl = null, privateKeyPath, feeRateShannons = 1000, logger = console }) {
  const privateKey = Buffer.from(fs.readFileSync(privateKeyPath, 'utf8').trim().replace(/^0x/, ''), 'hex');

  return {
    async buildBatchTransfer({ items }) {
      const { txHash } = await buildAndSendBatchPayout({
        rpcUrl,
        indexerUrl,
        privateKey,
        feeRateShannons,
        items,
      });
      logger.log('PAYOUT', `in-process builder: tx ${txHash} (${items.length} recipients)`);
      return { txHash, rawTx: null, async broadcast() { return { ok: true, txHash }; } };
    },
    async buildTransfer({ toAddress, capacityShannons }) {
      return this.buildBatchTransfer({ items: [{ address: toAddress, capacityShannons }] });
    },
  };
}

module.exports = { createCkbInProcessBuilder };
