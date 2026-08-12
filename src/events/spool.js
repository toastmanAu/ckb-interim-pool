'use strict';
/**
 * spool.js — append-only local WAL for accepted-share / block events.
 *
 * Durability contract (spec 06 §7): an accepted share is written to the WAL
 * (write(2), O_APPEND) before the miner is told anything that would let it
 * drop the share; fsync is batched (syncIntervalMs) — the documented
 * tradeoff for throughput. Power-loss can lose the un-fsynced tail; it must
 * be soak-tested (see acceptance §10).
 *
 * Fail-closed: when the spool cannot be written (disk full, I/O error) the
 * edge must stop accepting new shares — `append` throws and the edge marks
 * itself unhealthy.
 *
 * Format: one JSON envelope per line:
 *   {"seq":<int>,"crc":<uint32>,"event_id":<hex>,"body":{...event}}
 * Segments: wal-<bootId>.log; a new boot id → a new segment.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const MAX_LINE_BYTES = 1024 * 1024;

function createSpool({ dir, bootId, maxBytes = 512 * 1024 * 1024, highWaterBytes = 384 * 1024 * 1024, syncIntervalMs = 1000, logger = console }) {
  fs.mkdirSync(dir, { recursive: true });
  const segment = path.join(dir, `wal-${bootId}.log`);
  let fd = fs.openSync(segment, 'a');
  let buffered = 0;
  let writtenBytes = (() => { try { return fs.statSync(segment).size; } catch { return 0; } })();
  let cursorSeq = 0;          // highest seq durably appended
  let flusher = null;

  const flush = () => {
    try {
      fs.fsyncSync(fd);
    } catch (e) {
      logger.log('SPOOL', `fsync failed: ${e.message}`);
    }
  };
  flusher = setInterval(flush, syncIntervalMs);
  flusher.unref();   // background flusher must not hold the process open

  /** Append an event envelope ({seq, crc?, event_id, body}) to the WAL. Synchronous; throws on I/O failure. */
  function append(event) {
    const line = JSON.stringify({
      seq: event.seq,
      crc: zlib.crc32(Buffer.from(JSON.stringify(event.body || event))),
      event_id: event.event_id,
      body: event.body || event,
    }) + '\n';
    const bytes = Buffer.byteLength(line);
    if (bytes > MAX_LINE_BYTES) throw new Error('spool record too large');
    if (writtenBytes + bytes > maxBytes) {
      throw new Error(`spool at capacity (${writtenBytes}/${maxBytes}) — failing closed`);
    }
    const buf = Buffer.from(line, 'utf8');
    fs.writeSync(fd, buf, 0, buf.length, null);
    writtenBytes += bytes;
    buffered += bytes;
    if (event.seq > cursorSeq) cursorSeq = event.seq;
    return { seq: event.seq, bytes };
  }

  function flushNow() {
    flush();
    return writtenBytes;
  }

  /**
   * Replay all WAL records across ALL boot segments (a crash/restart creates
   * a new boot id and a new segment; unacked events from the previous boot
   * must still be replayed — at-least-once delivery).
   * Segments are read in lexicographic (boot-id ≈ time) order.
   */
  function replay() {
    const records = [];
    const segments = fs.readdirSync(dir).filter(f => /^wal-[0-9a-f]{32}\.log$/.test(f)).sort();
    for (const seg of segments) {
      const data = fs.readFileSync(path.join(dir, seg), 'utf8');
      for (const line of data.split('\n')) {
        if (!line.trim()) continue;
        let rec;
        try { rec = JSON.parse(line); } catch { throw new Error(`spool corrupt: bad JSON line in ${seg}`); }
        const bodyJson = Buffer.from(JSON.stringify(rec.body));
        if (zlib.crc32(bodyJson) !== rec.crc) throw new Error(`spool corrupt: crc mismatch at seq ${rec.seq} in ${seg}`);
        records.push(rec);
      }
    }
    records.sort((a, b) => {
      const ba = a.body?.edge_boot_id || '';
      const bb = b.body?.edge_boot_id || '';
      if (ba !== bb) return ba < bb ? -1 : 1;
      return a.seq - b.seq;
    });
    return records;
  }

  function close() {
    clearInterval(flusher);
    try { fs.fsyncSync(fd); } catch {}
    try { fs.closeSync(fd); } catch {}
  }

  return {
    append, replay, flushNow, close,
    get cursor() { return cursorSeq; },
    get bytes() { return writtenBytes; },
    get segment() { return segment; },
  };
}

module.exports = { createSpool };
