'use strict';
/**
 * memory-sink.js — in-memory event sink (tests / embedded consumer only).
 * Retains events in an array for assertions; never durable.
 */

function createMemorySink() {
  const events = [];
  return {
    events,
    async onShareEvent(evt) { events.push(evt); return evt; },
    async onBlockEvent(evt) { events.push(evt); return evt; },
  };
}

module.exports = { createMemorySink };
