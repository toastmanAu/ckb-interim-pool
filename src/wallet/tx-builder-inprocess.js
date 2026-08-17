'use strict';
/**
 * ckb-in-process.js — payout TxBuilder adapter over the self-contained
 * CKB transaction builder (src/wallet/tx-builder.js).
 *
 * The batch path produces ONE signed transaction for the whole payout batch
 * (spec 04 §11). The service supplies validated key bytes from keystore.js;
 * a key-path argument remains for the standalone dev-chain drill. Keys are
 * never logged.
 */

const fs = require('node:fs');
const { buildBatchPayout, broadcastPayout } = require('./tx-builder.js');

function createCkbInProcessBuilder({
  rpcUrl,
  indexerUrl = null,
  privateKey = null,
  privateKeyPath = null,
  feeRateShannons = 1000,
  logger = console,
}) {
  const signingKey = privateKey || Buffer.from(
    fs.readFileSync(privateKeyPath, 'utf8').trim().replace(/^0x/, ''), 'hex');

  return {
    async buildBatchTransfer({ items }) {
      const built = await buildBatchPayout({
        rpcUrl,
        indexerUrl,
        privateKey: signingKey,
        feeRateShannons,
        items,
      });
      logger.log('PAYOUT', `in-process builder: signed tx ${built.txHash} (${items.length} recipients)`);
      return {
        ...built,
        async broadcast() {
          const sent = await broadcastPayout({
            rpcUrl,
            rawTx: built.rawTx,
            expectedTxHash: built.txHash,
          });
          logger.log('PAYOUT', `in-process builder: broadcast tx ${sent.txHash}`);
          return sent;
        },
      };
    },
    async buildTransfer({ toAddress, capacityShannons }) {
      return this.buildBatchTransfer({ items: [{ address: toAddress, capacityShannons }] });
    },
  };
}

module.exports = { createCkbInProcessBuilder };
