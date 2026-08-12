'use strict';
/**
 * miner-sim.js — a small real-hashing Stratum miner for testing the pool.
 *
 * Connects to any stratum endpoint, subscribes/authorizes as
 * <address>[.worker], and mines the current job at the server-assigned
 * difficulty by brute-forcing Eaglesong nonces. Emits a line per accepted
 * share (plus per-share JSON with -j). Exits on SIGINT with totals.
 *
 * Usage:
 *   node test/tools/miner-sim.js <stratum-url> <ckb-address[.worker]> [-j] [-s seed]
 *
 * This is a TEST TOOL, not a production miner: it hashes far slower than any
 * ASIC and submits shares at whatever difficulty the server assigns.
 */

const net = require('node:net');
const { eaglesong } = require('../../src/mining/eaglesong.js');
const { meetsTargetLE } = require('../../src/mining/ckb-target.js');
const { diffToTargetLE } = require('../../src/mining/ckb-target.js');

const [url, username] = process.argv.slice(2);
const jsonOut = process.argv.includes('-j');
const seed = parseInt(process.argv[process.argv.indexOf('-s') + 1] || '1', 10);

if (!url || !username) {
  console.error('usage: miner-sim.js <stratum-url> <ckb-address[.worker]> [-j] [-s seed]');
  process.exit(2);
}
const m = /^(?:stratum\+tcp:\/\/)?([^:/]+):(\d+)$/.exec(url);
if (!m) { console.error('bad url (expect host:port)'); process.exit(2); }

const sock = net.connect(parseInt(m[2], 10), m[1]);
let buf = '';
let nextId = 1;
let currentJob = null;      // { jobId, powHash, targetLE, height }
let currentTarget = null;   // LE hex from mining.set_target
let family = 'goldshell';
let nonceCounter = seed;

const totals = { accepted: 0, rejected: 0, hashes: 0 };
const t0 = Date.now();

function send(o) { sock.write(JSON.stringify(o) + '\n'); }
function line(...a) { if (!jsonOut) console.log(...a); }

function tryMine() {
  if (!currentJob || !currentTarget) return;
  const pow = Buffer.from(currentJob.powHash, 'hex');
  const target = Buffer.from(currentTarget, 'hex');
  // mine a bounded window of nonces (yield periodically; this is a simulator)
  for (let i = 0; i < 2000; i++) {
    nonceCounter = (nonceCounter + 1) >>> 0;
    const n8 = nonceCounter.toString(16).padStart(8, '0');
    const full = '00000000'.repeat(4).slice(0, 24) + n8;   // 16-byte nonce, low 4 bytes counting
    const hash = eaglesong(Buffer.concat([pow, Buffer.from(full, 'hex')]));
    totals.hashes++;
    if (meetsTargetLE(hash, target)) {
      totals.accepted++;
      send({ id: nextId++, method: 'mining.submit', params: [username, currentJob.jobId, '00000000', '0', '0x' + n8] });
      line(`[${(Date.now() - t0) / 1000}s] share accepted (nonce 0x${n8}) — ${totals.accepted} accepted so far`);
      return;   // one share per pass; loop keeps calling
    }
  }
}

setInterval(tryMine, 1);

sock.setEncoding('utf8');
sock.on('data', d => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const str = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!str.trim()) continue;
    let msg; try { msg = JSON.parse(str); } catch { continue; }

    if (msg.id && msg.result === true && msg.error === null) {
      // submit ack
    } else if (msg.id && msg.result === false) {
      totals.rejected++;
      line(`[sim] submit rejected: ${JSON.stringify(msg.error)}`);
    } else if (msg.method === 'mining.notify') {
      currentJob = {
        jobId: msg.params[0],
        powHash: msg.params[1],
        height: msg.params[2],
        targetLE: msg.params[3],
      };
      if (msg.params[4] === true) line('[sim] clean job — restarting nonce window');
    } else if (msg.method === 'mining.set_target') {
      // target arrives BE for godminer, LE otherwise; detect by 64-hex + reverse if needed
      let t = msg.params[0];
      if (family === 'godminer') t = t.match(/.{2}/g).reverse().join('');
      currentTarget = t;
      line(`[sim] difficulty target set: ${t.slice(0, 16)}…`);
    } else if (msg.method === 'mining.set_difficulty') {
      line(`[sim] difficulty: ${msg.params[0]}`);
    } else if (msg.id === 1 && msg.result && Array.isArray(msg.result)) {
      const [subs, en1, en2size] = msg.result;
      if (Array.isArray(subs)) { family = 'goldshell'; send({ id: nextId++, method: 'mining.authorize', params: [username, 'x'] }); }
      else { family = 'godminer'; send({ id: nextId++, method: 'mining.authorize', params: [username, 'x'] }); }
    }
  }
});

sock.on('connect', () => {
  line(`[sim] connected to ${url}, authorizing as ${username}`);
  send({ id: 1, method: 'mining.subscribe', params: ['miner-sim/0.1'] });
});
sock.on('error', e => { console.error('[sim] socket error:', e.message); process.exit(1); });

process.on('SIGINT', () => {
  const s = (Date.now() - t0) / 1000;
  console.log(`\n[sim] ${s.toFixed(0)}s — hashes=${totals.hashes} (${(totals.hashes / s / 1e3).toFixed(0)} kH/s) accepted=${totals.accepted} rejected=${totals.rejected}`);
  process.exit(0);
});
