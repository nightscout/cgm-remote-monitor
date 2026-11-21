'use strict';

// Owned-client counters only. No pg_stat_statements reset, driver patch, values,
// credentials, server clocks or polling-derived executor latency. Migrations
// open their own clients and are deliberately outside this bridge's coverage.
const { AsyncLocalStorage } = require('node:async_hooks');
const { createHash } = require('node:crypto');
const { Client } = require('pg');
const assert = require('node:assert/strict');
const FULL = /operation-window-(?:role|table|function|ledger)\b|evaluator-consumer-suppression-(?:role|table|function|ledger)\b/;
const DIGEST = /operation-window-epoch|suppression-epoch|string_agg[\s\S]*xmin|encode\(sha256\(convert_to\(concat_ws/;
function create () {
  const context = new AsyncLocalStorage(), records = new Map();
  function record (text) {
    if (typeof text !== 'string') throw new TypeError('SQL text required');
    const phase = context.getStore() || 'unscoped';
    const normalized = text.replace(/\s+/g, ' ').trim();
    const digest = createHash('sha256').update(normalized).digest('hex');
    const key = phase + ':' + digest;
    const row = records.get(key) || { phase, digest, count: 0, fullAdmission: FULL.test(text), globalDigest: DIGEST.test(text) };
    row.count++; records.set(key, row);
  }
  class CountedClient extends Client {
    query (...args) { record(typeof args[0] === 'string' ? args[0] : args[0].text); return super.query(...args); }
  }
  return { Client: CountedClient, record,
    phase: (name, fn) => context.run(name, fn),
    rows: () => [...records.values()].map(row => ({ ...row })),
    assertHot (phase, operations) {
      assert.ok(Number.isSafeInteger(operations) && operations > 0, 'explicit public operation denominator');
      const rows = [...records.values()].filter(row => row.phase === phase);
      assert.ok(rows.length, 'owned clients observed real SQL');
      assert.equal(rows.reduce((n, r) => n + (r.fullAdmission || r.globalDigest ? r.count : 0), 0), 0,
        'steady public operations must not repeat full admission or global catalogue digests');
      return { operations, statements: rows.reduce((n, r) => n + r.count, 0), statementsPerOperation: rows.reduce((n, r) => n + r.count, 0) / operations };
    }
  };
}
module.exports = { create };
