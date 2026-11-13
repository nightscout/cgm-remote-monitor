'use strict';

// Actual pg.Pool checkout/release mechanics with a synthetic driver Client.
// No socket/database is opened. HTTP/backend termination remains a real lab.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const connect = require('../lib/storage/postgres-connection');
const scope = require('../lib/storage/tenant-scope');
const decorate = require('../lib/storage/postgres-write-clock');
const { withCommitEvents } = require('../lib/storage/postgres-intent-common');
const intent = require('../lib/storage/write-intent');
const TENANT = '11111111-1111-4111-8111-111111111111';

describe('checked-out PostgreSQL client failure propagation', function () {
  let previous;
  beforeEach(function () { previous = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  afterEach(function () { scope.setTenancyMode(previous); });

  async function fixture () {
    const clients = [], calls = [];
    let action = async () => undefined;
    class SyntheticClient extends EventEmitter {
      constructor () {
        super();
        this._queryable = true;
        this._ending = false;
        this.dead = false;
        clients.push(this);
      }
      connect (done) { queueMicrotask(() => done(null)); }
      query (text, values, done) {
        if (typeof values === 'function') done = values;
        const execute = async () => {
          calls.push({ client: this, text });
          if (this.dead) throw new Error('Synthetic connection is closed');
          await action(this, text);
          if (text.includes('FROM pg_roles')) return { rows: [{ rolsuper: false, rolbypassrls: false }] };
          if (text.includes('SELECT last_stamp')) return { rows: [{ last_stamp: '100' }] };
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
    const store = await connect({ connectionString: 'synthetic-test-connection', Client: SyntheticClient,
      max: 1, idleTimeoutMillis: 0 });
    return { store, clients, calls, setAction: fn => { action = fn; } };
  }

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
      await f.store.query('SELECT before_gap');
      const client = f.calls.find(call => call.text === 'SELECT before_gap').client;
      continuation = new Promise(resolve => { resume = resolve; }).then(() =>
        assert.rejects(async () => f.store.query('SELECT retained_scope'), /scope is closed/));
      client.dead = true;
      assert.doesNotThrow(() => client.emit('error', failure));
      await assert.rejects(f.store.query('SELECT after_gap'), error => error === failure);
      return { items: [] };
    } }, { connection: clock, bus, logical: 'entries', source: 'v3' });
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
  async function fixture (phase) {
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
            const role = text.includes('FROM pg_roles'), names = role ? ['rolsuper', 'rolbypassrls'] : ['value'];
            connection.emit('rowDescription', { fields: names.map(name => ({ name, dataTypeID: role ? 16 : 23, format: 'text' })) });
            connection.emit('dataRow', { fields: names.map(() => Buffer.from(role ? 'f' : '1')) });
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
});
