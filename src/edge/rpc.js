'use strict';
/**
 * rpc.js — CKB JSON-RPC client (trusted private node only).
 * Extracted from ckb-stratum-proxy solo-proxy.js @ 4d57892 (timeout, error
 * shape) with no behavior change.
 */

const http = require('node:http');

function createRpcClient({ host = '127.0.0.1', port = 8114, timeoutMs = 8000 } = {}) {
  function rpc(method, params) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
      const req = http.request({
        host, port, method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: timeoutMs,
      }, res => {
        let d = '';
        res.on('data', c => { d += c; });
        res.on('end', () => {
          try {
            const msg = JSON.parse(d);
            if (msg.error) reject(new Error(JSON.stringify(msg.error)));
            else resolve(msg.result);
          } catch (e) { reject(e); }
        });
      });
      req.on('timeout', () => { req.destroy(new Error(`RPC timeout: ${method}`)); });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }
  return { rpc };
}

module.exports = { createRpcClient };
