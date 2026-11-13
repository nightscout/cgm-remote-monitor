'use strict';
// covers: lib/diagnostics/m7.js, lib/diagnostics/m7-log-worker.js
const assert = require('node:assert/strict');
const { create } = require('../lib/diagnostics/m7');
const inertSink = () => ({ state: () => 'ready', send: (bytes, callback) => { callback(true); return true; }, close () {} });
const observed = () => create({ enabled: true, intervalMs: 60000, sinkFactory: inertSink });
describe('bounded opt-in M7 diagnostics', function () {
  it('leaves disabled methods and functions unchanged and never reads a clock or starts a sink', function () {
    const diag = create({ clock: () => assert.fail('disabled clock'), sinkFactory: () => assert.fail('disabled sink') });
    const pool = { connect () {}, end () {} }, fn = async () => 1, connect = pool.connect;
    assert.equal(diag.observePool(pool, 'storage'), pool); assert.equal(pool.connect, connect); assert.equal(diag.wrapAsync(fn, 'api.authorize'), fn);
    diag.time('api.authorize')(); diag.delta('window.outer_bodies', 1); assert.equal(diag.snapshot().status, 'UNMEASURED'); diag.close();
  });
  it('preserves callback/Promise results, errors and this without double-counting SQL', async () => {
    const diag = observed(), value = {}, error = new Error('synthetic-private-error'), queryReturn = {}, release = () => {};
    const client = { query (text, callback) { assert.equal(this, client); if (callback) { callback.call(queryReturn, text === 'bad' ? error : null, value); return queryReturn; } return text === 'bad' ? Promise.reject(error) : Promise.resolve(value); } };
    const pool = { totalCount: 1, idleCount: 0, waitingCount: 0,
      connect (callback) { assert.equal(this, pool); if (callback) { callback.call(pool, null, client, release); return queryReturn; } return Promise.resolve(client); },
      end (callback) { assert.equal(this, pool); if (callback) { callback.call(pool); return queryReturn; } return Promise.resolve(value); } };
    try {
      diag.observePool(pool, 'storage'); assert.equal(await pool.connect(), client);
      assert.equal(await client.query('good'), value); await assert.rejects(client.query('bad'), found => found === error);
      assert.equal(client.query('good', function (err, found) { assert.equal(this, queryReturn); assert.equal(err, null); assert.equal(found, value); }), queryReturn);
      assert.equal(pool.connect(function (err, found, done) { assert.equal(this, pool); assert.equal(err, null); assert.equal(found, client); assert.equal(done, release); }), queryReturn);
      const snapshot = diag.snapshot(); assert.equal(snapshot.pools.storage.activeSQL, 0); assert.equal(snapshot.pools.storage.sqlObservations, 3);
      assert.equal(snapshot.durations['pool.query_storage'].count, 3); assert.equal(snapshot.durations['pool.wait_storage'].count, 2);
      assert(!JSON.stringify(snapshot).includes(error.message)); assert.equal(await pool.end(), value); assert.equal(diag.snapshot().pools.storage.tracked, 0);
    } finally { diag.close(); }
  });
  it('keeps asynchronous authorization result/error identity and this intact', async () => {
    const diag = observed(), value = {}, error = new Error('synthetic-only'), owner = {};
    const fn = async function (bad) { assert.equal(this, owner); if (bad) throw error; return value; };
    try { const wrapped = diag.wrapAsync(fn, 'api.authorize'); assert.equal(await wrapped.call(owner, false), value); await assert.rejects(wrapped.call(owner, true), found => found === error); assert.equal(diag.snapshot().durations['api.authorize'].count, 2); }
    finally { diag.close(); }
  });
  it('leaves custom Query instances and config callbacks untouched and marks missing coverage', async () => {
    const diag = observed(), customResult = {}, callback = () => {};
    class Query { submit () {} }
    const custom = new Query(), config = { text: 'synthetic', callback };
    const client = { query (input) { assert(input === custom || input === config); assert.equal(input.callback, input === config ? callback : undefined); return customResult; } };
    const pool = { totalCount: 1, idleCount: 0, waitingCount: 0, connect: async () => client, end: async () => {} };
    try {
      diag.observePool(pool, 'storage'); await pool.connect();
      assert.equal(client.query(custom), customResult); assert.equal(client.query(config), customResult);
      assert.equal(diag.snapshot().pools.storage.unsupportedQueryForms, 2); assert.equal(diag.snapshot().pools.storage.sqlStatus, 'UNMEASURED');
    } finally { await pool.end(); diag.close(); }
  });
  it('separates held physical clients, active SQL and inclusive outer bodies with fixed labels', async () => {
    const diag = observed(); let resolve;
    const client = { query: () => new Promise(r => { resolve = r; }) };
    const pool = { totalCount: 1, idleCount: 0, waitingCount: 2, connect: async () => client, end: async () => {} };
    try {
      diag.configureRoles(['api']); diag.observePool(pool, 'operation'); await pool.connect(); diag.delta('window.outer_bodies', 1);
      let snapshot = diag.snapshot(); assert.equal(snapshot.pools.operation.checkedout, 1); assert.equal(snapshot.pools.operation.waiting, 2); assert.equal(snapshot.pools.operation.activeSQL, 0);
      const pending = client.query('synthetic-secret-sql'); snapshot = diag.snapshot(); assert.equal(snapshot.pools.operation.activeSQL, 1);
      resolve({}); await pending; snapshot = diag.snapshot(); assert.equal(snapshot.pools.operation.activeSQL, 0); assert.equal(snapshot.gauges['window.outer_bodies'].value, 1);
      assert(!JSON.stringify(snapshot).includes('synthetic-secret-sql')); assert.deepEqual(snapshot.roles, ['api']);
      assert.equal(snapshot.durations['api.authorize'].status, 'UNMEASURED'); assert.equal(snapshot.bucketsUpperMs.length, 13);
    } finally { await pool.end(); diag.close(); }
  });
  it('bounds pool registry and output, drops pressure/failure and does not await sink shutdown', async () => {
    let state = 'backpressure', callback, closed = 0, size;
    const diag = create({ enabled: true, intervalMs: 60000, sinkFactory: () => ({ state: () => state,
      send: (bytes, done) => { size = bytes.byteLength; callback = done; return true; }, close: () => { closed++; } }) });
    try {
      for (let i = 0; i < 65; i++) diag.observePool({ totalCount: 0, idleCount: 0, waitingCount: 0, connect: async () => ({}), end: async () => {} }, 'storage');
      assert.equal(diag.snapshot().pools.storage.tracked, 64); assert.equal(diag.snapshot().poolOverflow, 1); assert.equal(diag.snapshot().pools.storage.status, 'UNMEASURED');
      assert.equal(diag.emit(), false); assert.equal(diag.snapshot().logging.backpressure, 1);
      state = 'ready'; assert.equal(diag.emit(), true); assert(size <= 8192); callback(false); assert.equal(diag.snapshot().logging.unavailable, 1);
      assert.equal(diag.snapshot().logging.status, 'UNMEASURED'); diag.close(); assert.equal(closed, 1);
    } finally { diag.close(); }
  });
});
