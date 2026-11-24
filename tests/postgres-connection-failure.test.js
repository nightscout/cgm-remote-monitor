'use strict';

// Actual pg.Pool checkout/release mechanics with a synthetic driver Client.
// No socket/database is opened. HTTP/backend termination remains a real lab.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const connect = require('../lib/storage/postgres-connection');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
// Synthetic driver tests isolate only the actual-driver protocol port. The
// packet-event suite separately exercises the fixed shipping Client itself.
function recordingConnection (Client, mutate = source => source) {
  const filename = path.resolve(__dirname, '../lib/storage/postgres-connection.js'), loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = loaded.require.bind(loaded);
  loaded.require = name => name === './postgres-settings-protocol' ? { Client, settled: async () => {}, assertTransaction () {}, assertRollback () {}, assertUnlock () {} } : name === '../tenant-lifecycle/operation-window' ? { ...original(name), schedulingParent: (window, tenant) => window.parentToken ? window.parentToken(tenant) : null } : original(name);
  loaded._compile(mutate(fs.readFileSync(filename, 'utf8')), filename); return loaded.exports;
}
const scope = require('../lib/storage/tenant-scope');
const decorate = require('../lib/storage/postgres-write-clock');
const { withCommitEvents } = require('../lib/storage/postgres-intent-common');
const intent = require('../lib/storage/write-intent');
const TENANT = '11111111-1111-4111-8111-111111111111';

describe('checked-out PostgreSQL client failure propagation', function () {
  let previous;
  beforeEach(function () { previous = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  afterEach(function () { scope.setTenancyMode(previous); });

  async function fixture (extra = {}, mutate) {
    const clients = [], calls = [];
    let action = async () => undefined;
    class SyntheticClient extends EventEmitter {
      constructor (options) {
        super();
        this.options = options;
        this._queryable = true;
        this._ending = false;
        this.dead = false;
        this.processID = 100 + clients.length;
        clients.push(this);
      }
      connect (done) { queueMicrotask(() => done(null)); }
      query (text, values, done) {
        if (typeof values === 'function') done = values;
        const execute = async () => {
          calls.push({ client: this, text, values });
          if (this.dead) throw new Error('Synthetic connection is closed');
          const override = await action(this, text, values);
          if (override) return override;
          if (text.includes('pg_backend_pid() AS pid')) return { rows: [{ rolsuper: false, rolbypassrls: false, pid: this.processID, role: this.options.user || 'synthetic', birth: '100', database: 'synthetic_test', database_oid: '123', server_address: '127.0.0.1', server_port: 5432, postmaster_birth: '1' }] };
          if (text.includes('FROM pg_roles')) return { rows: [{ rolsuper: false, rolbypassrls: false }] };
          if (text.includes("current_setting('transaction_read_only')")) return { rows: [{ read_only: 'on', isolation: 'repeatable read' }] };
          if (text.includes('SELECT last_stamp')) return { rows: [{ last_stamp: '100' }] };
          if (text.startsWith('UPDATE "synthetic_clock".tenant_write_clock') && text.endsWith('RETURNING last_stamp')) {
            return { command: 'UPDATE', rowCount: 1, rows: [{ last_stamp: String(Math.max(101, values[1])) }] };
          }
          return { rows: [], command: text.split(' ')[0], rowCount: 1 };
        };
        if (done) { execute().then(result => done(null, result), error => done(error)); return; }
        return execute();
      }
      end (done) {
        this._ending = true;
        this.emit('end');
        if (done) queueMicrotask(done);
      }
    }
    const store = await recordingConnection(SyntheticClient, mutate)({ connectionString: 'postgres://synthetic:synthetic@127.0.0.1/synthetic_test', direct: true, displaySettings: true, application_name: 'nightscout-display-settings',
      max: 1, idleTimeoutMillis: 0, ...extra });
    return { store, clients, calls, setAction: fn => { action = fn; } };
  }

  it('reuses only removed transaction-owned savepoint slots and rejects overlapping scopes', async function () {
    const f = await fixture();
    try {
      await scope.withTenant(TENANT, () => f.store.transaction(async () => {
        for (let i = 0; i < 6; i++) await f.store.withSavepoint(async () => {
          await assert.rejects(f.store.withSavepoint(async () => {}), /concurrent or nested/);
        });
        const primary = Error('synthetic operation');
        await assert.rejects(f.store.withSavepoint(async () => { throw primary; }), e => e === primary);
        await f.store.withSavepoint(async () => {});
      }));
      const names = f.calls.filter(c => c.text.startsWith('SAVEPOINT ')).map(c => c.text);
      assert.equal(names.length, 8);
      assert.deepEqual([...new Set(names)], ['SAVEPOINT ns_owned_sp_0']);
      assert(f.calls.some(c => c.text === 'ROLLBACK TO SAVEPOINT ns_owned_sp_0'));
    } finally { await f.store.end(); }
  });

  it('quarantines a savepoint slot when cleanup is unconfirmed', async function () {
    const f = await fixture(); let fail = true;
    f.setAction(async (client, text) => {
      if (fail && text.startsWith('ROLLBACK TO SAVEPOINT')) { fail = false; throw Error('synthetic uncertain removal'); }
    });
    try {
      await scope.withTenant(TENANT, () => f.store.transaction(async () => {
        await assert.rejects(f.store.withSavepoint(async () => { throw Error('primary'); }), /savepoint rollback failed/);
        await f.store.withSavepoint(async () => {});
      }));
      assert.deepEqual(f.calls.filter(c => c.text.startsWith('SAVEPOINT ')).map(c => c.text),
        ['SAVEPOINT ns_owned_sp_0', 'SAVEPOINT ns_owned_sp_1']);
    } finally { await f.store.end(); }
  });

  it('owns a READ ONLY repeatable snapshot with a closed bounded facade and max1 reuse', async function () {
    const f = await fixture(); let retained;
    try {
      await f.store.readOnlySnapshot(TENANT, async facade => {
        retained = facade; assert.deepEqual(Object.keys(facade), ['query']); assert(Object.isFrozen(facade));
        await facade.query('SELECT snapshot_read'); await facade.query('SELECT snapshot_read_two');
      });
      await assert.rejects(async () => retained.query('SELECT late'), /scope is closed/);
      await f.store.readOnlySnapshot(TENANT, async ({ query }) => { await query('SELECT followup'); });
      assert.equal(f.clients.length, 1);
      assert.equal(f.calls.filter(call => call.text === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY').length, 2);
      assert(!f.calls.some(call => call.text === 'SELECT late' || call.text.startsWith('UPDATE')));
      await scope.withTenant(TENANT, () => f.store.transaction(async () => {
        assert.throws(() => f.store.readOnlySnapshot(TENANT, () => {}), /requires a new transaction/);
      }));
    } finally { await f.store.end(); }
  });

  it('latches caught facade validation refusals and prevents later SQL or COMMIT in the same snapshot', async function () {
    for (const invalid of ['UPDATE synthetic SET value=1', 'SELECT 1; SELECT 2']) {
      const f = await fixture(); let refusal;
      try {
        await assert.rejects(f.store.readOnlySnapshot(TENANT, async ({ query }) => {
          await assert.rejects(async () => query(invalid), error => { refusal = error; return /one SELECT/.test(error.message); });
          await assert.rejects(async () => query('SELECT attempted_recovery'), error => error === refusal);
          return 'caught refusal';
        }), error => error === refusal);
        assert(!f.calls.some(call => call.text === invalid || call.text === 'SELECT attempted_recovery' || call.text === 'COMMIT'));
        assert.equal(f.clients[0]._ending, true);
      } finally { await f.store.end(); }
    }
  });

  it('refuses both completed and pending unawaited facade queries before COMMIT and drains pending work', async function () {
    for (const pending of [false, true]) {
      const f = await fixture(); let finish, started;
      const reached = new Promise(resolve => { started = resolve; });
      const gate = new Promise(resolve => { finish = resolve; });
      f.setAction(async (client, text) => { if (text === 'SELECT detached') { started(); if (pending) await gate; } });
      const reading = f.store.readOnlySnapshot(TENANT, async ({ query }) => {
        query('SELECT detached');
        if (!pending) await new Promise(resolve => setImmediate(resolve));
      });
      reading.catch(() => {});
      try {
        await reached; await new Promise(resolve => setImmediate(resolve));
        assert(!f.calls.some(call => call.text === 'COMMIT'));
        finish(); await assert.rejects(reading, /unawaited queries/);
        assert(!f.calls.some(call => call.text === 'COMMIT'));
        assert.equal(f.clients[0]._ending, true);
      } finally { finish(); await Promise.allSettled([reading]); await f.store.end(); }
    }
  });

  it('rejects a swallowed snapshot query failure, evicts it and preserves the primary with failed rollback', async function () {
    for (const rollbackFails of [false, true]) {
      const f = await fixture(), primary = Error('snapshot primary'), cleanup = Error('snapshot rollback');
      f.setAction(async (client, text) => {
        if (text === 'SELECT failure') throw primary;
        if (rollbackFails && text === 'ROLLBACK') throw cleanup;
      });
      try {
        await assert.rejects(f.store.readOnlySnapshot(TENANT, async ({ query }) => {
          await assert.rejects(async () => query('SELECT failure'), error => error === primary);
          return 'caught';
        }), error => rollbackFails ? error.code === 'POSTGRES_CLEANUP_UNCONFIRMED' && error.cause === primary && error.cleanupError === cleanup : error === primary);
        assert(!f.calls.some(call => call.text === 'COMMIT')); assert.equal(f.clients[0]._ending, true);
      } finally { await f.store.end(); }
    }
  });

  it('evicts every failed strict snapshot phase and a fresh checkout recovers', async function () {
    for (const phase of ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'SELECT snapshot_work', 'COMMIT']) {
      const f = await fixture(), primary = Error('snapshot phase ' + phase);
      f.setAction(async (client, text) => { if (text === phase) throw primary; });
      try {
        await assert.rejects(f.store.readOnlySnapshot(TENANT, async ({ query }) => { await query('SELECT snapshot_work'); }), error => error === primary);
        assert.equal(f.clients[0]._ending, true);
        f.setAction(async () => {});
        await f.store.readOnlySnapshot(TENANT, async ({ query }) => { await query('SELECT recovered'); });
        assert.equal(f.clients.length, 2);
      } finally { await f.store.end(); }
    }
  });

  it('normalizes the direct URL without dropping explicit timeouts, SSL or hidden credentials', async function () {
    const f = await fixture({ direct: true, connectionString: 'postgres://synthetic:synthetic@127.0.0.1/synthetic_test',
      query_timeout: 1234, connectionTimeoutMillis: 2345, application_name: 'nightscout-display-settings', ssl: { rejectUnauthorized: true } });
    try {
      const actual = f.clients[0].options;
      assert.equal(actual.connectionString, undefined); assert.equal(actual.query_timeout, 1234);
      assert.equal(actual.connectionTimeoutMillis, 2345); assert.equal(actual.application_name, 'nightscout-display-settings');
      assert.deepEqual(actual.ssl, { rejectUnauthorized: true }); assert.equal(actual.password, 'synthetic');
      assert.equal(Object.getOwnPropertyDescriptor(actual, 'password').enumerable, false);
      assert.equal(actual.options, '-c search_path=pg_catalog'); assert.equal(actual.database, 'synthetic_test');
      const ConnectionParameters = require('pg/lib/connection-parameters');
      const effective = new ConnectionParameters(actual);
      assert.equal(effective.query_timeout, 1234); assert.equal(effective.connect_timeout, 2);
      assert.equal(effective.application_name, 'nightscout-display-settings'); assert.deepEqual(effective.ssl, { rejectUnauthorized: true });
      const unsafeURL = 'postgres://synthetic:synthetic@127.0.0.1/synthetic_test?query_timeout=6000&connectionTimeoutMillis=6000';
      const uncontrolled = new ConnectionParameters({ connectionString: unsafeURL, query_timeout: 1000, connectionTimeoutMillis: 1000 });
      assert.equal(String(uncontrolled.query_timeout), '6000'); assert.equal(uncontrolled.connect_timeout, 6);
      assert.throws(() => assert.equal(uncontrolled.query_timeout, 1000), { code: 'ERR_ASSERTION' });
      for (const connectionString of [unsafeURL, 'postgres://synthetic:synthetic@127.0.0.1/synthetic_test?connect_timeout=6000']) {
        await assert.rejects(connect({ connectionString, direct: true, query_timeout: 1000, connectionTimeoutMillis: 1000 }), { code: 'MIG_CONNECTION' });
      }

    } finally { await f.store.end(); }
  });

  it('keeps selected physical lease/admission identity fresh and preserves cleanup failure with the primary', async function () {
    const calls = []; let lease, actual, failUnlock = false;
    const unlock = Error('synthetic snapshot unlock'), primary = Error('synthetic snapshot value');
    const window = {
      run: (tenant, fn) => fn(), assertCurrent () {},
      async acquireClient (client, tenant) { actual = client; assert.equal(tenant, TENANT); calls.push('acquire'); lease = { async close () { calls.push('release'); if (failUnlock) throw unlock; } }; return lease; },
      async assertClient (client, tenant, held) { assert.equal(client, actual); assert.equal(tenant, TENANT); assert.equal(held, lease); calls.push('admit'); }
    };
    const f = await fixture({ operationWindow: window });
    try {
      for (let i = 0; i < 2; i++) await f.store.readOnlySnapshot(TENANT, async ({ query }) => { calls.push('value'); await query('SELECT selected'); });
      assert.deepEqual(calls, ['acquire', 'admit', 'value', 'release', 'acquire', 'admit', 'value', 'release']);
      assert.equal(f.calls.filter(call => call.text.endsWith('FROM pg_catalog.pg_stat_get_activity(pg_catalog.pg_backend_pid())')).length, 2, 'each strict checkout freshly observes its own backend');
      failUnlock = true;
      await assert.rejects(f.store.readOnlySnapshot(TENANT, () => { throw primary; }), error => error.code === 'POSTGRES_CLEANUP_UNCONFIRMED' && error.cause === primary && error.cleanupError === unlock);
      assert.equal(f.clients[0]._ending, true);
    } finally { await f.store.end(); }
  });

  it('refuses wrong server read-only/isolation proof before caller work', async function () {
    for (const state of [{ read_only: 'off', isolation: 'repeatable read' }, { read_only: 'on', isolation: 'read committed' }]) {
      const f = await fixture(); let ran = false;
      f.setAction(async (client, text) => text.includes("current_setting('transaction_read_only')") ? { rows: [state] } : undefined);
      try {
        await assert.rejects(f.store.readOnlySnapshot(TENANT, () => { ran = true; }), /read-only repeatable snapshot required/);
        assert.equal(ran, false); assert.equal(f.clients[0]._ending, true); assert(!f.calls.some(call => call.text === 'COMMIT'));
      } finally { await f.store.end(); }
    }
  });

  it('preserves a primary refusal and client release failure as distinct outcomes', async function () {
    const f = await fixture(), primary = Error('snapshot primary release'), cleanup = Error('snapshot release failed');
    f.setAction(async (client, text) => {
      if (text === 'SELECT failed_release') {
        const release = client.release; client.release = error => { release(error); throw cleanup; };
        throw primary;
      }
    });
    try {
      await assert.rejects(f.store.readOnlySnapshot(TENANT, async ({ query }) => { await query('SELECT failed_release'); }),
        error => error.code === 'POSTGRES_CLEANUP_UNCONFIRMED' && error.cause === primary && error.cleanupError === cleanup);
      assert.equal(f.clients[0]._ending, true);
    } finally { await f.store.end(); }
  });

  it('refuses success when a detached facade call races with COMMIT without issuing late SQL', async function () {
    const f = await fixture(); let facade, late;
    f.setAction(async (client, text) => { if (text === 'COMMIT') { late = facade.query('SELECT late_commit'); late.catch(() => {}); } });
    try {
      await assert.rejects(f.store.readOnlySnapshot(TENANT, async capability => { facade = capability; await facade.query('SELECT current'); }), /scope is closed/);
      await assert.rejects(late, /scope is closed/); assert(!f.calls.some(call => call.text === 'SELECT late_commit'));
      assert.equal(f.clients[0]._ending, true);
    } finally { await f.store.end(); }
  });

  it('keeps the selected parent scope live through awaited work and refuses a closed parent before serving', async function () {
    const { AsyncLocalStorage } = require('node:async_hooks'), scopes = new AsyncLocalStorage();
    const window = {
      run (tenant, fn) {
        const parent = scopes.getStore();
        if (parent) { if (!parent.active || parent.tenant !== tenant) throw Error('synthetic closed parent'); return fn(); }
        const current = { tenant, active: true };
        return scopes.run(current, async () => { try { return await fn(); } finally { current.active = false; } });
      },
      parentToken (tenant) { const current = scopes.getStore(); if (current && (!current.active || current.tenant !== tenant)) throw Error('synthetic closed parent'); return current || null; },
      async acquireClient () { return { async close () {} }; }, async assertClient () {}
    };
    const f = await fixture({ operationWindow: window }); let release, entered, reading;
    const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    f.setAction(async (client, text) => { if (text === 'SELECT held_parent') { entered(); await gate; } });
    try {
      await window.run(TENANT, async () => {
        reading = f.store.readOnlySnapshot(TENANT, async ({ query }) => { await query('SELECT held_parent'); }); reading.catch(() => {});
        await started;
      });
      release(); await assert.rejects(reading, /synthetic closed parent/);
      assert(!f.calls.some(call => call.text === 'COMMIT')); assert.equal(f.clients[0]._ending, true);
      await f.store.readOnlySnapshot(TENANT, async ({ query }) => { await query('SELECT own_parent'); });
    } finally { release(); await reading?.catch(() => {}); await f.store.end(); }
  });

  it('captures true parent absence without markers and refuses an appearing or replaced same-tenant parent', async function () {
    for (const initial of [null, {}]) {
      let parent = initial, markers = 0;
      const window = { parentToken: () => parent, run () { markers++; throw Error('must remain marker-free'); },
        async acquireClient () { return { async close () {} }; }, async assertClient () {} };
      const f = await fixture({ operationWindow: window });
      try {
        await f.store.readOnlySnapshot(TENANT, async ({ query }) => { await query('SELECT stable_parent'); });
        assert.equal(markers, 0);
        await assert.rejects(f.store.readOnlySnapshot(TENANT, async ({ query }) => {
          parent = {}; await query('SELECT changed_parent');
        }), { code: 'POSTGRES_SETTINGS_PARENT_CHANGED' });
        assert(!f.calls.some(call => call.text === 'SELECT changed_parent')); assert.equal(markers, 0);
      } finally { await f.store.end(); }
    }
  });

  it('refuses inherited actual window authority when no window is configured', async function () {
    const f = await fixture(), window = require('./fixtures/operation-window-runtime-protocol')();
    try {
      await window.window.run(TENANT, async () => {
        assert.throws(() => f.store.readOnlySnapshot(TENANT, () => {}), { code: 'LIFECYCLE_WINDOW_AMBIENT_SCOPE' });
      });
      assert(!f.calls.some(call => call.text === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'));
    } finally { await f.store.end(); await window.window.close(); }
  });

  it('declares repeatable-read snapshots explicitly and refuses to upgrade an outer transaction', async function () {
    const f = await fixture();
    try {
      await scope.withTenant(TENANT, () => f.store.snapshotTransaction(() => f.store.query('SELECT snapshot_work')));
      assert.equal(f.calls.filter(call => call.text === 'BEGIN ISOLATION LEVEL REPEATABLE READ').length, 1);
      await scope.withTenant(TENANT, () => f.store.transaction(async () => {
        await assert.rejects(async () => f.store.snapshotTransaction(() => {}), /snapshot requires a new transaction/);
      }));
      assert.equal(f.calls.filter(call => call.text === 'BEGIN').length, 1, 'ordinary transactions retain their default');
    } finally { await f.store.end(); }
  });

  it('returns no successful snapshot when its COMMIT fails', async function () {
    const f = await fixture();
    f.setAction(async (client, text) => {
      if (text === 'COMMIT') throw new Error('synthetic snapshot commit failure');
    });
    try {
      await scope.withTenant(TENANT, () => assert.rejects(f.store.snapshotTransaction(async () => 'uncommitted projection'),
        /synthetic snapshot commit failure/));
      assert.equal(f.calls.some(call => call.text === 'ROLLBACK'), true);
    } finally { await f.store.end(); }
  });

  for (const phase of ['BEGIN', 'config', 'SELECT synthetic_work', 'COMMIT']) {
    it('rejects a client event during ' + phase + ', evicts it, and admits a fresh healthy connection', async function () {
      const f = await fixture();
      const failure = new Error('Synthetic socket death');
      const at = text => phase === 'config' ? text.includes('set_config') : text === phase;
      let broken;
      f.setAction(async (client, text) => {
        if (!broken && at(text)) {
          broken = client;
          client.dead = true;
          // Deliberately let this query resolve afterwards: the transaction
          // must reject a known client failure even alongside a result.
          client.emit('error', failure);
        }
      });
      try {
        await scope.withTenant(TENANT, () => assert.rejects(f.store.transaction(() => f.store.query('SELECT synthetic_work')), error => {
          assert.equal(error.cause, failure);
          assert.match(error.rollbackError.message, /closed/);
          return true;
        }));
        assert.ok(broken);
        // Failure during COMMIT means no successful acknowledgement here;
        // this synthetic driver does not prove whether real data committed.
        if (phase !== 'COMMIT') assert.equal(f.calls.some(call => call.client === broken && call.text === 'COMMIT'), false);
        f.setAction(async () => undefined);
        await scope.withTenant(TENANT, () => f.store.query('SELECT healthy_followup'));
        const followup = f.calls.find(call => call.text === 'SELECT healthy_followup');
        assert.notEqual(followup.client, broken);
        assert.equal(broken._ending, true);
      } finally { await f.store.end(); }
    });
  }

  it('rejects work after a gap failure, closes retained scopes and emits no logical commit', async function () {
    const f = await fixture();
    const clock = decorate(f.store, 'synthetic_clock');
    const bus = new EventEmitter();
    let events = 0, resume, continuation;
    bus.on(intent.INTENT_EVENT, () => { events++; });
    const failure = new Error('Synthetic socket death between queries');
    const step = withCommitEvents({ write: async () => {
      require('../lib/server/srv-dates').next();
      await f.store.query('SELECT before_gap');
      const client = f.calls.find(call => call.text === 'SELECT before_gap').client;
      continuation = new Promise(resolve => { resume = resolve; }).then(() =>
        assert.rejects(async () => f.store.query('SELECT retained_scope'), /scope is closed/));
      client.dead = true;
      assert.doesNotThrow(() => client.emit('error', failure));
      await assert.rejects(f.store.query('SELECT after_gap'), error => error === failure);
      return { items: [] };
    } }, { connection: clock, bus, logical: 'entries', source: 'v3', stampedV3Writes: true });
    try {
      await scope.withTenant(TENANT, () => assert.rejects(step.write({ op: 'create' }), error => {
        assert.equal(error.cause, failure);
        return true;
      }));
      assert.equal(events, 0);
      assert.equal(f.calls.some(call => call.text === 'SELECT after_gap' || call.text === 'COMMIT'), false);
      resume();
      await continuation;
      assert.equal(f.calls.some(call => call.text === 'SELECT retained_scope'), false);
    } finally { await f.store.end(); }
  });

  it('blocks success even when a caller catches a failed native query and attempts another query', async function () {
    const f = await fixture();
    const server = Object.assign(new Error('Synthetic server termination'), { code: '57P01' });
    const transport = new Error('Synthetic socket death');
    f.setAction(async (client, text) => {
      if (text === 'SELECT terminated_query') {
        client.dead = true;
        client.emit('error', transport);
        throw server;
      }
    });
    try {
      await scope.withTenant(TENANT, () => assert.rejects(f.store.transaction(async () => {
        await assert.rejects(f.store.query('SELECT terminated_query'), error => error === server);
        await assert.rejects(f.store.query('SELECT attempted_after_death'), error => error === transport);
        return 'caller tried to recover';
      }), error => error.cause === transport));
      assert.equal(f.calls.some(call => call.text === 'SELECT attempted_after_death' || call.text === 'COMMIT'), false);
    } finally { await f.store.end(); }
  });

  it('records an event while fn awaits an unrelated promise and refuses its later successful return', async function () {
    const f = await fixture();
    let ready, release, client;
    const reached = new Promise(resolve => { ready = resolve; });
    const gap = new Promise(resolve => { release = resolve; });
    const failure = new Error('Synthetic idle-in-transaction transport death');
    const writing = scope.withTenant(TENANT, () => f.store.transaction(async () => {
      await f.store.query('SELECT before_async_gap');
      client = f.calls.find(call => call.text === 'SELECT before_async_gap').client;
      ready();
      await gap;
      return 'caller completed without another query';
    }));
    writing.catch(() => {});
    try {
      await reached;
      client.dead = true;
      assert.doesNotThrow(() => client.emit('error', failure));
      release();
      await assert.rejects(writing, error => error.cause === failure);
      assert.equal(f.calls.some(call => call.text === 'COMMIT'), false);
    } finally {
      release();
      await Promise.allSettled([writing]);
      await f.store.end();
    }
  });

  it('keeps ordinary SQL errors unchanged after successful rollback and reuses the healthy client', async function () {
    const f = await fixture();
    const violation = Object.assign(new Error('Synthetic constraint failure'), { code: '23514' });
    let used;
    f.setAction(async (client, text) => {
      if (text === 'SELECT constraint_failure') { used = client; throw violation; }
    });
    try {
      await scope.withTenant(TENANT, () => assert.rejects(f.store.query('SELECT constraint_failure'), error => error === violation));
      assert.ok(f.calls.some(call => call.text === 'ROLLBACK'));
      assert.equal(used._ending, false);
      f.setAction(async () => undefined);
      await scope.withTenant(TENANT, () => f.store.query('SELECT healthy_followup'));
      assert.equal(f.calls.find(call => call.text === 'SELECT healthy_followup').client, used);
    } finally { await f.store.end(); }
  });

  // The pinned driver's query_timeout rejects with this uncoded error while
  // the statement may still run: nothing more may be queued behind it.
  const missedDeadline = () => new Error('Query read timeout');
  for (const [label, run] of [
    ['a statement', store => store.query('SELECT slow_work')],
    ['a statement inside a savepoint', store => store.transaction(() => store.withSavepoint(() => store.query('SELECT slow_work')))],
    ['a statement whose failure the caller swallows', store => store.transaction(async () => {
      await store.query('SELECT slow_work').catch(() => {});
      return 'swallowed';
    })]
  ]) {
    it('refuses ' + label + ' that missed its local deadline as STORAGE_TIMEOUT, sends no ROLLBACK or COMMIT and evicts the client', async function () {
      const f = await fixture();
      let used;
      f.setAction(async (client, text) => { if (text === 'SELECT slow_work') { used = client; throw missedDeadline(); } });
      try {
        await scope.withTenant(TENANT, () => assert.rejects(run(f.store), error => {
          assert.equal(error.code, 'STORAGE_TIMEOUT');
          assert.equal(error.retryAfter, 1);
          assert.match(error.cause.message, /Query read timeout|savepoint rollback failed/);
          return true;
        }));
        const after = f.calls.slice(f.calls.findIndex(call => call.text === 'SELECT slow_work') + 1).filter(call => call.client === used);
        assert.deepEqual(after.map(call => call.text), [], 'NOTHING_QUEUED_BEHIND_UNKNOWN_WORK');
        assert.equal(used._ending, true, 'EVICTED');
        f.setAction(async () => undefined);
        await scope.withTenant(TENANT, () => f.store.query('SELECT healthy_followup'));
        assert.notEqual(f.calls.find(call => call.text === 'SELECT healthy_followup').client, used);
      } finally { await f.store.end(); }
    });
  }

  it('leaves a COMMIT that missed its deadline an unknown outcome: no refusal code, no ROLLBACK, evicted', async function () {
    const f = await fixture();
    let used;
    f.setAction(async (client, text) => { if (text === 'COMMIT') { used = client; throw missedDeadline(); } });
    try {
      await scope.withTenant(TENANT, () => assert.rejects(f.store.query('SELECT work'), error => {
        assert.equal(error.code, undefined, 'a COMMIT without reply is not reported as nothing written');
        assert.match(error.message, /Query read timeout/);
        return true;
      }));
      assert.equal(f.calls.some(call => call.client === used && call.text === 'ROLLBACK'), false);
      assert.equal(used._ending, true);
    } finally { await f.store.end(); }
  });

  it('refuses a transaction that found no free pooled client in time as STORAGE_BUSY', async function () {
    const f = await fixture({ max: 1, connectionTimeoutMillis: 30 });
    let release;
    const held = new Promise(resolve => { release = resolve; });
    try {
      const first = scope.withTenant(TENANT, () => f.store.transaction(() => held));
      await new Promise(resolve => setTimeout(resolve, 5));
      await scope.withTenant(TENANT, () => assert.rejects(f.store.query('SELECT waiting_work'), error => {
        assert.equal(error.code, 'STORAGE_BUSY');
        assert.equal(error.retryAfter, 1);
        assert.match(error.cause.message, /timeout exceeded when trying to connect/);
        return true;
      }));
      assert.equal(f.calls.some(call => call.text === 'SELECT waiting_work'), false);
      release();
      await first;
    } finally { await f.store.end(); }
  });

  // The refusal names where it was produced (nightscout_storage_refusals_total
  // phase): a lock wait on the tenant write clock row, the transaction's
  // opening statements, any other statement, or the pool checkout.
  for (const [label, phase, failing, run] of [
    ['the write clock row lock (FOR UPDATE)', 'clock', text => /tenant_write_clock .*FOR UPDATE/.test(text),
      store => decorate(store, 'synthetic_clock').transaction(() => store.query('SELECT body_work'))],
    ['the write clock reservation (UPDATE ... RETURNING)', 'clock', text => /^UPDATE "synthetic_clock"\.tenant_write_clock/.test(text),
      store => decorate(store, 'synthetic_clock').transaction(() => store.query('SELECT body_work'), { reserveFirst: true })],
    ['a statement under the clock', 'statement', text => text === 'SELECT body_work',
      store => decorate(store, 'synthetic_clock').transaction(() => store.query('SELECT body_work'))],
    ['an unlocked clock read', 'statement', text => /^SELECT last_stamp FROM "synthetic_clock"\.tenant_write_clock WHERE tenant_id = \$1$/.test(text),
      store => decorate(store, 'synthetic_clock').transaction(() => store.query('SELECT body_work'), { settleBeforeLock: async () => true })],
    ['the opening tenant binding', 'open', text => text.includes("set_config('app.current_tenant_id'"),
      store => store.query('SELECT body_work')]
  ]) {
    it('marks a STORAGE_TIMEOUT on ' + label + ' with phase ' + phase, async function () {
      const f = await fixture();
      f.setAction(async (client, text) => { if (typeof text === 'string' && failing(text)) throw missedDeadline(); });
      try {
        await scope.withTenant(TENANT, () => assert.rejects(run(f.store), error => {
          assert.equal(error.code, 'STORAGE_TIMEOUT');
          assert.equal(error.phase, phase);
          return true;
        }));
      } finally { await f.store.end(); }
    });
  }

  it('marks a STORAGE_BUSY with phase checkout', async function () {
    const f = await fixture({ max: 1, connectionTimeoutMillis: 30 });
    let release;
    const held = new Promise(resolve => { release = resolve; });
    try {
      const first = scope.withTenant(TENANT, () => f.store.transaction(() => held));
      await new Promise(resolve => setTimeout(resolve, 5));
      await scope.withTenant(TENANT, () => assert.rejects(f.store.query('SELECT waiting_work'), error => {
        assert.equal(error.code, 'STORAGE_BUSY');
        assert.equal(error.phase, 'checkout');
        return true;
      }));
      release();
      await first;
    } finally { await f.store.end(); }
  });

  it('preserves a server SQLSTATE and transport rollback cause as distinct failures', async function () {
    const f = await fixture();
    const server = Object.assign(new Error('Synthetic administrator termination'), { code: '57P01' });
    const transport = new Error('Synthetic subsequent socket termination');
    f.setAction(async (client, text) => {
      if (text === 'SELECT server_termination') {
        client.dead = true;
        client.emit('error', transport);
        throw server;
      }
    });
    try {
      await scope.withTenant(TENANT, () => assert.rejects(f.store.query('SELECT server_termination'), error => {
        assert.equal(error.cause, server);
        assert.equal(error.cause.code, '57P01');
        assert.equal(error.connectionError, transport);
        assert.match(error.rollbackError.message, /closed/);
        return true;
      }));
    } finally { await f.store.end(); }
  });

  it('hands healthy clients back to the idle pool without accumulating transaction listeners', async function () {
    const f = await fixture();
    try {
      for (let index = 0; index < 4; index++) {
        await scope.withTenant(TENANT, () => f.store.query('SELECT healthy_followup'));
        assert.equal(f.clients[0].listenerCount('error'), 1, 'Only the pool idle listener remains');
      }
      assert.equal(f.clients.length, 1);
    } finally { await f.store.end(); }
  });
});

describe('actual driver read-only outage cleanup', function () {
  async function fixture (phase, { readOnlyMode = 'on' } = {}) {
    const clients = [], submitted = [], wire = []; let held;
    class Stream extends EventEmitter {
      constructor () { super(); this.writable = true; this.destroyed = false; }
      write () { return true; }
      ref () {}
      unref () {}
      end () { this.writable = false; }
      destroy () { this.destroyed = true; this.writable = false; queueMicrotask(() => this.emit('close', false)); return this; }
    }
    class RecordingClient extends require('pg').Client {
      constructor (options) {
        super(options); clients.push(this);
        const connection = this.connection, stream = new Stream(); connection.stream = stream;
        const reply = text => {
          if (text.startsWith('SELECT')) {
            const role = text.includes('FROM pg_roles'), mode = text.includes('default_transaction_read_only');
            const names = role ? ['rolsuper', 'rolbypassrls'] : [mode ? 'mode' : 'value'];
            connection.emit('rowDescription', { fields: names.map(name => ({ name, dataTypeID: role ? 16 : mode ? 25 : 23, format: 'text' })) });
            connection.emit('dataRow', { fields: names.map(() => Buffer.from(role ? 'f' : mode ? readOnlyMode : '1')) });
          }
          connection.emit('commandComplete', { text: text.startsWith('SELECT') ? 'SELECT 1' : text.split(' ')[0] });
          connection.emit('readyForQuery', { status: text === 'COMMIT' || text === 'ROLLBACK' ? 'I' : 'T' });
        };
        connection.connect = () => { connection._connecting = true; stream.once('close', () => connection.emit('end')); queueMicrotask(() => connection.emit('readyForQuery', { status: 'I' })); };
        connection.query = text => {
          wire.push(text);
          if (text === phase) { held = () => reply(text); return; }
          queueMicrotask(() => reply(text));
        };
      }
      query (...args) { submitted.push(typeof args[0] === 'string' ? args[0] : args[0].text); return super.query(...args); }
    }
    const store = await connect({ connectionString: 'postgres://synthetic:synthetic@synthetic-pg/outage_test', Client: RecordingClient,
      max: 1, ssl: false, query_timeout: 30, connectionTimeoutMillis: 30, idleTimeoutMillis: 0 });
    return { store, clients, submitted, wire, resume: () => held?.() };
  }
  for (const phase of ['BEGIN READ ONLY', 'SELECT outage_work', 'COMMIT']) it('rejects an unanswered ' + phase + ' without queueing rollback or accepting a late result', async function () {
    const f = await fixture(phase); let accepted = false;
    try {
      await assert.rejects(f.store.readOnly('SELECT outage_work').then(() => { accepted = true; }), /Query read timeout/);
      assert(!f.submitted.includes('ROLLBACK'), 'failed READ ONLY backend is evicted; no cleanup statement goes behind unknown work');
      assert.equal(accepted, false); assert.equal(f.clients[0].connection.stream.destroyed, true);
      f.resume(); await new Promise(resolve => setImmediate(resolve));
      assert.equal(accepted, false, 'late driver packets cannot turn a refused read into success');
    } finally { await f.store.end(); }
  });
  // Trusted metadata reads (evaluator scheduling and work state) are one
  // statement: no BEGIN READ ONLY/COMMIT. PostgreSQL's READ ONLY mode is not
  // there to refuse a write, so the port itself admits only one SELECT.
  it('sends a trusted metadata read as one statement and refuses anything but one SELECT', async function () {
    const f = await fixture();
    try {
      await f.store.readStatement('SELECT outage_work', []); // the first checkout screens its backend once
      assert.equal(f.clients.length, 2, 'READ_STATEMENT_HAS_ITS_OWN_POOL');
      assert.match(f.clients[1].connectionParameters.options, /-c default_transaction_read_only=on/, 'READ_POOL_STARTS_READ_ONLY');
      assert(f.submitted.some(text => text.includes("current_setting('default_transaction_read_only')")), 'READ_BACKEND_CHECKED_ONCE');
      const before = f.submitted.length;
      const result = await f.store.readStatement('SELECT outage_work', []);
      assert.equal(result.rows.length, 1);
      assert.deepEqual(f.submitted.slice(before), ['SELECT outage_work'], 'ONE_STATEMENT_PER_METADATA_READ');
      for (const text of ['WITH w AS (UPDATE t SET x=1 RETURNING x) SELECT x FROM w', 'SELECT 1; UPDATE t SET x=1',
        'UPDATE t SET x=1', 'select_into', undefined]) {
        await assert.rejects(f.store.readStatement(text), /one SELECT/, 'READ_STATEMENT_REFUSES ' + text);
      }
      assert.deepEqual(f.submitted.slice(before).filter(text => !/^(BEGIN|COMMIT|ROLLBACK|SELECT set_config)/.test(text)), ['SELECT outage_work'], 'NO_REFUSED_TEXT_SUBMITTED');
    } finally { await f.store.end(); }
  });
  it('refuses a read backend that did not start read-only, before running the read', async function () {
    const f = await fixture(undefined, { readOnlyMode: 'off' });
    try {
      await assert.rejects(f.store.readStatement('SELECT outage_work', []), error => error.code === 'POSTGRES_READ_STATEMENT_WRITABLE');
      assert(!f.submitted.includes('SELECT outage_work'), 'NO_READ_ON_A_WRITABLE_BACKEND');
    } finally { await f.store.end(); }
  });
  it('rejects an unanswered single-statement metadata read without accepting a late result', async function () {
    const f = await fixture('SELECT outage_work'); let accepted = false;
    try {
      await assert.rejects(f.store.readStatement('SELECT outage_work').then(() => { accepted = true; }), /Query read timeout/);
      assert(!f.submitted.includes('ROLLBACK'));
      assert.equal(f.clients.at(-1).connection.stream.destroyed, true, 'the failed backend is evicted');
      f.resume(); await new Promise(resolve => setImmediate(resolve));
      assert.equal(accepted, false);
    } finally { await f.store.end(); }
  });
});
