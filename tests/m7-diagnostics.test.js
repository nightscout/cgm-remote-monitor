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
  function heldFixture (implementation = create) {
    const { EventEmitter } = require('node:events');
    let now = 0, releases = 0;
    const value = {}, failure = new Error('synthetic release failure');
    const client = { query: async () => value };
    const pool = new EventEmitter();
    Object.assign(pool, { totalCount: 1, idleCount: 0, waitingCount: 0,
      connect (callback) {
        assert.equal(this, pool);
        now += 3; pool.emit('acquire', client);
        let released = false;
        client.release = function (error) {
          assert.equal(this, client);
          if (released) throw failure;
          released = true; releases++; pool.emit('release', error, client); return value;
        };
        if (callback) { callback.call(pool, null, client, client.release); return value; }
        return Promise.resolve(client);
      }, end: async () => value });
    const diag = implementation({ enabled: true, intervalMs: 60000, sinkFactory: inertSink, clock: () => now });
    diag.observePool(pool, 'storage');
    return { diag, pool, client, value, failure, releases: () => releases, advance: ms => { now += ms; } };
  }
  async function heldCriterion (implementation = create) {
    const f = heldFixture(implementation);
    try {
      const client = await f.pool.connect(); f.advance(7);
      assert.equal(f.diag.snapshot().pools.storage.heldActive, 1);
      assert.equal(f.diag.snapshot().durations['pool.held_storage'].status, 'UNMEASURED');
      assert.equal(client.release.call(client, f.failure), f.value);
      const snapshot = f.diag.snapshot();
      assert.equal(snapshot.pools.storage.heldActive, 0);
      assert.equal(snapshot.pools.storage.heldObservations, 1);
      assert.equal(snapshot.pools.storage.heldStatus, 'MEASURED');
      assert.equal(snapshot.durations['pool.wait_storage'].sumMs, 3);
      assert.equal(snapshot.durations['pool.held_storage'].count, 1);
      assert.equal(snapshot.durations['pool.held_storage'].sumMs, 7);
      assert.equal(snapshot.durations['pool.query_storage'].count, 0);
      assert.throws(() => client.release(), error => error === f.failure);
      assert.equal(f.releases(), 1);
      assert.equal(f.diag.snapshot().durations['pool.held_storage'].count, 1);
      assert(!JSON.stringify(snapshot).includes(f.failure.message));
    } finally { f.diag.close(); }
  }
  it('separates actual checkout event spans from wait/query and preserves release/error identity', async () => {
    await heldCriterion();
    const f = heldFixture();
    try {
      let raw;
      assert.equal(f.pool.connect(function (error, client, release) {
        assert.equal(this, f.pool); assert.equal(error, null); assert.equal(client, f.client);
        assert.equal(release, client.release); raw = release; f.advance(11); release.call(client);
      }), f.value);
      assert.equal(f.diag.snapshot().durations['pool.held_storage'].sumMs, 11);
      assert.equal(f.diag.snapshot().pools.storage.heldObservations, 1);
      assert.equal(raw, f.client.release);
      assert.equal(f.pool.listenerCount('acquire'), 1); assert.equal(f.pool.listenerCount('release'), 1);
      await f.pool.end(); assert.equal(f.pool.listenerCount('acquire'), 0); assert.equal(f.pool.listenerCount('release'), 0);
    } finally { f.diag.close(); }
  });
  it('observes the installed pg.Pool lifecycle without a database or release wrappers', async () => {
    const { EventEmitter } = require('node:events'), { Pool } = require('pg');
    let now = 0;
    class Client extends EventEmitter {
      constructor () { super(); this._queryable = true; this._ending = false; }
      connect (callback) { now += 3; queueMicrotask(() => callback(null)); }
      query (text, callback) { now += 2; const value = { rows: [{ synthetic: true }] }; if (callback) { callback(null, value); return; } return Promise.resolve(value); }
      end (callback) { this._ending = true; this.emit('end'); callback?.(); }
    }
    const pool = new Pool({ Client, max: 1, idleTimeoutMillis: 0 });
    const diag = create({ enabled: true, intervalMs: 60000, sinkFactory: inertSink, clock: () => now });
    diag.observePool(pool, 'storage');
    let first, second;
    try {
      first = await pool.connect(); const release = first.release; const queued = pool.connect();
      assert.equal(pool.waitingCount, 1); now += 7; release(); first = null; second = await queued;
      assert.deepEqual(await second.query('synthetic'), { rows: [{ synthetic: true }] }); now += 5;
      const secondRelease = second.release; secondRelease(); second = null;
      const snapshot = diag.snapshot();
      assert.equal(snapshot.pools.storage.heldObservations, 2); assert.equal(snapshot.pools.storage.heldActive, 0);
      assert.equal(snapshot.pools.storage.heldStatus, 'MEASURED'); assert.equal(snapshot.durations['pool.held_storage'].sumMs, 14);
      assert.equal(snapshot.durations['pool.wait_storage'].sumMs, 10); assert.equal(snapshot.durations['pool.query_storage'].sumMs, 2);
      assert.equal(snapshot.pools.storage.sqlObservations, 1);
    } finally { first?.release(); second?.release(); await pool.end(); diag.close(); }
  });
  it('fails a checkout-span omission control and restores the actual held-duration oracle', async () => {
    const fs = require('node:fs'), Module = require('node:module'), path = require('node:path');
    const filename = require.resolve('../lib/diagnostics/m7'), original = fs.readFileSync(filename, 'utf8');
    const needle = 'record.heldActive--; end(); record.heldObservations++;';
    assert(original.includes(needle), 'exact held-duration control source required');
    const broken = new Module(filename, module); broken.filename = filename; broken.paths = Module._nodeModulePaths(path.dirname(filename));
    broken._compile(original.replace(needle, 'record.heldActive--; record.heldObservations++;'), filename);
    await assert.rejects(heldCriterion(broken.exports.create), error => error.code === 'ERR_ASSERTION' && error.actual === 0 && error.expected === 1);
    await heldCriterion();
  });
  it('marks missing/unmatched lifecycle events unmeasured without wrapping client release', async () => {
    const f = heldFixture();
    try {
      const previouslyCheckedOut = { release () {} }, release = previouslyCheckedOut.release;
      f.pool.emit('release', null, previouslyCheckedOut); f.pool.emit('acquire', null);
      await f.pool.connect(); f.advance(2); f.client.release();
      assert.equal(previouslyCheckedOut.release, release);
      assert.equal(f.diag.snapshot().pools.storage.heldStatus, 'UNMEASURED');
      assert.equal(f.diag.snapshot().pools.storage.unsupportedHoldTracking, 2);
      f.diag.close(); assert.equal(f.pool.listenerCount('acquire'), 0); assert.equal(f.pool.listenerCount('release'), 0);
    } finally { f.diag.close(); }
    const diag = observed(), client = { query: async () => ({}), release () {} }, release = client.release;
    const pool = { totalCount: 1, idleCount: 0, waitingCount: 0, connect: async () => client, end: async () => {} };
    try {
      diag.observePool(pool, 'operation'); await pool.connect(); client.release();
      const snapshot = diag.snapshot(); assert.equal(client.release, release);
      assert.equal(snapshot.pools.operation.heldStatus, 'UNMEASURED');
      assert.equal(snapshot.durations['pool.held_operation'].status, 'UNMEASURED');
      assert.equal(snapshot.pools.operation.unsupportedHoldTracking, 1);
    } finally { diag.close(); }
  });
  it('records failed checkout wait without inventing a held connection or changing errors', async () => {
    const failure = new Error('synthetic connect failure'); let now = 0;
    const diag = create({ enabled: true, intervalMs: 60000, sinkFactory: inertSink, clock: () => now });
    const { EventEmitter } = require('node:events'), pool = new EventEmitter();
    Object.assign(pool, { totalCount: 0, idleCount: 0, waitingCount: 0, end: async () => {}, connect (callback) {
      assert.equal(this, pool); now += 5;
      if (callback) { callback.call(pool, failure); return failure; }
      throw failure;
    } });
    try {
      diag.observePool(pool, 'storage'); assert.throws(() => pool.connect(), error => error === failure);
      assert.equal(pool.connect(function (error) { assert.equal(this, pool); assert.equal(error, failure); }), failure);
      assert.equal(diag.snapshot().durations['pool.wait_storage'].count, 2);
      assert.equal(diag.snapshot().durations['pool.held_storage'].count, 0);
      assert.equal(diag.snapshot().pools.storage.heldStatus, 'UNMEASURED');
    } finally { diag.close(); }
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
