'use strict';
/**
 * mock-node.js — fake CKB node for tests (HTTP JSON-RPC + WebSocket
 * new_tip_header). Supports template rotation and submit_block capture.
 * NOT consensus code — test scaffolding only.
 */

const http = require('node:http');
const { WebSocketServer } = require('ws');
const merkle = require('../../src/mining/ckb-merkle.js');

function createMockNode({ templates = [] } = {}) {
  let templateIndex = 0;
  let workCounter = 0;
  let pushCallback = null;
  const submitted = [];
  const methods = {
    get_block_template: () => {
      const tpl = templates[templateIndex] || templates[0];
      if (!tpl) throw new Error('no templates configured');
      const workId = (tpl.work_id || '0x1') === '0xauto'
        ? '0x' + (++workCounter).toString(16)
        : tpl.work_id;
      return { ...structuredClone(tpl), work_id: workId };
    },
    submit_block: params => {
      submitted.push({ workId: params[0], block: params[1] });
      return null; // CKB returns null on success
    },
    get_tip_header: () => {
      const tpl = templates[templateIndex] || templates[0];
      return {
        number: tpl?.number || '0x0',
        hash: tpl?.parent_hash || '0x' + '00'.repeat(32),
      };
    },
  };

  const server = http.createServer((req, res) => {
    let d = '';
    req.on('data', c => { d += c; });
    req.on('end', () => {
      let msg;
      try { msg = JSON.parse(d); } catch {
        res.writeHead(400); res.end('{"error":"bad json"}'); return;
      }
      let result, error = null;
      try {
        result = methods[msg.method] ? methods[msg.method](msg.params) : (() => { throw new Error(`unknown method ${msg.method}`); })();
      } catch (e) {
        error = { code: -32601, message: e.message };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: error ? undefined : result, error }));
    });
  });

  let wss = null;
  let wsReady = false;

  return {
    submitted,
    httpServer: server,
    async listen() {
      await new Promise(res => server.listen(0, '127.0.0.1', res));
      wss = new WebSocketServer({ server });
      wss.on('connection', ws => {
        ws.on('message', data => {
          let msg;
          try { msg = JSON.parse(data); } catch { return; }
          if (msg.method === 'subscribe' && msg.params?.[0] === 'new_tip_header') {
            wsReady = true;
            ws.send(JSON.stringify({ id: msg.id, jsonrpc: '2.0', result: 'mock-sub-id' }));
            pushCallback = () => {
              ws.send(JSON.stringify({
                jsonrpc: '2.0', method: 'subscribe',
                params: { result: null, subscription: 'new_tip_header' },
              }));
            };
          }
        });
      });
      return this;
    },
    get port() { return server.address().port; },
    get wsPort() { return server.address().port; },
    get wsConnected() { return wsReady; },
    /** Rotate to the next template and push a new_tip_header notification. */
    pushNewTip() {
      templateIndex = (templateIndex + 1) % templates.length;
      if (pushCallback) pushCallback();
      else throw new Error('no WS subscriber connected');
    },
    async close() {
      await new Promise(res => { try { server.close(res); } catch { res(); } });
      try { wss?.clients.forEach(c => c.terminate()); } catch {}
    },
  };
}

module.exports = { createMockNode };
