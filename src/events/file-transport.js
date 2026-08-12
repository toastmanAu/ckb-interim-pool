'use strict';
/**
 * file-transport.js — durable file transport (test / single-host fallback).
 *
 * Each publish appends one NDJSON record per event to
 * <dir>/export-<bootId>.log with fsync. A central consumer can tail the
 * file; replay semantics are identical to NATS (read file, dedup by
 * event_id). Used by tests to prove pipeline semantics without a broker.
 */

const fs = require('node:fs');
const path = require('node:path');

function createFileTransport({ dir, logger = console }) {
  fs.mkdirSync(dir, { recursive: true });
  let fd = null;
  const records = [];

  function start() {
    fd = fs.openSync(path.join(dir, 'export.log'), 'a');
    return Promise.resolve(this);
  }

  async function publish(subject, event) {
    const line = JSON.stringify({ subject, event, at_ms: Date.now() }) + '\n';
    fs.writeSync(fd, Buffer.from(line, 'utf8'), 0, line.length, null);
    fs.fsyncSync(fd);
    records.push(event);
    return true;
  }

  async function close() {
    try { fs.closeSync(fd); } catch {}
  }

  return { start, publish, close, records };
}

module.exports = { createFileTransport };
