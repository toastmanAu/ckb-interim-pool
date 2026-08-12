'use strict';
/**
 * metrics.js — edge metrics (counters + gauges, Prometheus text render).
 * Kept dependency-free so the edge stays small; a separate exporter can scrape.
 */

function createMetrics() {
  const counters = new Map();
  const gauges = new Map();

  function inc(name, n = 1) { counters.set(name, (counters.get(name) || 0) + n); }
  function gauge(name, value) { gauges.set(name, value); }

  function text() {
    const lines = [];
    for (const [k, v] of [...counters.entries()].sort()) {
      lines.push(`# TYPE pool_${k} counter`, `pool_${k} ${v}`);
    }
    for (const [k, v] of [...gauges.entries()].sort()) {
      lines.push(`# TYPE pool_${k} gauge`, `pool_${k} ${v}`);
    }
    return lines.join('\n') + '\n';
  }

  return { inc, gauge, counters, gauges, text };
}

module.exports = { createMetrics };
