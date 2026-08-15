'use strict';
/**
 * Refresh test/fixtures/treasury-receipts-mainnet.json from a trusted node.
 *
 *   POOL_NODE_RPC=http://<host>:8114 node test/tools/capture-receipt-fixtures.js
 *
 * Run this to add new cases (notably the first block mined after a
 * block_assembler change, which is the case most worth pinning). The test
 * itself never touches the network.
 */
const fs = require('node:fs');
const path = require('node:path');
const { createRpcClient } = require('../../src/edge/rpc.js');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'treasury-receipts-mainnet.json');
const url = process.env.POOL_NODE_RPC || 'http://127.0.0.1:8114';
const client = createRpcClient({
  host: url.replace(/^https?:\/\//, '').split(':')[0],
  port: parseInt(url.split(':').pop(), 10),
});

(async () => {
  const fx = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  for (const c of fx.cases) {
    const mined = await client.rpc('get_block_by_number', ['0x' + c.blockHeight.toString(16)]);
    const payout = await client.rpc('get_block_by_number', ['0x' + c.payoutBlockHeight.toString(16)]);
    c.cellbaseWitness = mined.transactions[0].witnesses[0];
    c.payoutBlock = {
      header: { number: payout.header.number, epoch: payout.header.epoch, hash: payout.header.hash },
      transactions: [{ hash: payout.transactions[0].hash, outputs: payout.transactions[0].outputs }],
    };
    console.log(`captured ${c.blockHeight} -> ${c.payoutBlockHeight}`);
  }
  fs.writeFileSync(FIXTURE, JSON.stringify(fx, null, 1) + '\n');
  console.log('wrote', FIXTURE);
})().catch(e => { console.error(e); process.exit(1); });
