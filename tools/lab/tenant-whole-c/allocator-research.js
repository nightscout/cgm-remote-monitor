'use strict';

// Optional, separately reviewed private-sequence counterexample only. Never used
// by lifecycle import or as a recovery implementation. No app-role grant changes.
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { quote } = require('./oracle');
async function cachedAllocatorCounterexample ({ admin, observer, connectionString, namespace, emit, ClientType = Client }) {
  const sequence = quote(namespace) + '."whole_c_private_cache_probe"';
  assert.equal((await observer.query('SELECT to_regclass($1) AS found', [sequence])).rows[0].found, null);
  const retained = new ClientType({ connectionString }), fresh = new ClientType({ connectionString });
  let created = false;
  try {
    await emit('C5-owned-private-cache-sequence', { sequence, scope: 'operator research sessions; not application allocator configuration or tenant restore' });
    await admin.query('CREATE SEQUENCE ' + sequence + ' CACHE 8'); created = true;
    await retained.connect(); await fresh.connect();
    const first = (await retained.query('SELECT nextval($1::regclass)::text AS value', [sequence])).rows[0].value;
    const before = (await observer.query('SELECT last_value::text,is_called FROM ' + sequence)).rows[0];
    // Looks forward-only against visible global counter, yet retained backend
    // still owns cached values. SIGSTOP of its client would not close that cache.
    await admin.query('SELECT setval($1::regclass,100,true)', [sequence]);
    const newer = (await fresh.query('SELECT nextval($1::regclass)::text AS value', [sequence])).rows[0].value;
    const cached = (await retained.query('SELECT nextval($1::regclass)::text AS value', [sequence])).rows[0].value;
    const after = (await observer.query('SELECT last_value::text,is_called FROM ' + sequence)).rows[0];
    const observation = { first, before, maintenanceFloor: '100', newer, cached, after,
      meaning: 'forward setval does not invalidate another live backend cache; no recovery algorithm selected' };
    await emit('C5-private-cache-counterexample-before-verdict', observation);
    assert.ok(BigInt(before.last_value) < 100n && BigInt(newer) > 100n && BigInt(cached) < 100n, 'WHOLE_C_CACHED_ALLOCATOR_COUNTEREXAMPLE');
    return observation;
  } finally {
    await retained.end(); await fresh.end();
    if (created) await admin.query('DROP SEQUENCE ' + sequence);
  }
}
module.exports = { cachedAllocatorCounterexample };
