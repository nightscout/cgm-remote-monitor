'use strict';
// Actual pg.Client dispatch/packet handlers with a recording transport. No socket,
// authentication server, PostgreSQL, admission or physical-close claim.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const protocol = require('../lib/storage/postgres-settings-protocol');
class Stream extends EventEmitter {
  constructor () { super(); this.writable = true; this.destroyed = false; }
  write (bytes, done) { if (done) queueMicrotask(done); return true; }
  end () { this.writable = false; }
  destroy () { this.destroyed = true; this.writable = false; queueMicrotask(() => this.emit('close')); }
}
async function fixture () {
  const client = new protocol.Client({ host: 'synthetic-pg', ssl: false }), connection = client.connection, stream = new Stream();
  connection.stream = stream;
  connection.connect = function () { this._connecting = true; stream.once('close', () => this.emit('end')); };
  const connected = client.connect(); connection.emit('readyForQuery', { status: 'I' }); await connected;
  const finish = status => { connection.emit('commandComplete', { text: 'SELECT 1' }); connection.emit('readyForQuery', { status }); };
  return { client, connection, stream, finish, async begin () { const q = client.query('BEGIN READ ONLY'); finish('T'); await q; },
    async close () { const ending = client.end(); stream.emit('end'); stream.emit('close'); await ending; } };
}
// Recording transport under the fixed shipping Client and actual pg.Pool.
// SQL replies exercise wire handlers; they are not PostgreSQL/RLS evidence.
async function snapshotFixture () {
  const pg = require('pg'), scope = require('../lib/storage/tenant-scope');
  const connect = require('../lib/storage/postgres-connection'), calls = [], clients = [];
  const originalConnect = protocol.Client.prototype.connect, originalQuery = protocol.Client.prototype.query;
  let releaseHeld;
  class PoolStream extends Stream {
    end () { this.writable = false; queueMicrotask(() => { this.emit('end'); this.emit('close', false); }); }
    destroy () { this.destroyed = true; this.end(); } ref () {} unref () {}
  }
  protocol.Client.prototype.query = function (sql, ...args) {
    const callback = args.at(-1);
    return typeof callback === 'function' ? originalQuery.call(this, sql, callback) : originalQuery.call(this, sql);
  };
  protocol.Client.prototype.connect = function (...args) {
    clients.push(this); const connection = this.connection, stream = new PoolStream(); let status = 'I';
    connection.stream = stream; this.processID = 101 + clients.length;
    connection.connect = function () { this._connecting = true; stream.once('close', () => this.emit('end')); queueMicrotask(() => this.emit('readyForQuery', { status: 'I' })); };
    connection.query = sql => {
      calls.push(sql);
      const finish = () => {
        let row;
        if (sql.includes('pg_backend_pid() AS pid')) row = { rolsuper: false, rolbypassrls: false, pid: this.processID, role: 'synthetic', birth: '100', database: 'synthetic_test', database_oid: '123', server_address: '127.0.0.1', server_port: 5432, postmaster_birth: '1' };
        if (sql.includes("current_setting('transaction_read_only')")) row = { read_only: 'on', isolation: 'repeatable read' };
        if (row) {
          connection.emit('rowDescription', { fields: Object.entries(row).map(([name, value]) => ({ name, tableID: 0, columnID: 0, dataTypeID: typeof value === 'boolean' ? 16 : typeof value === 'number' ? 23 : 25, dataTypeSize: -1, dataTypeModifier: -1, format: 'text' })) });
          connection.emit('dataRow', { fields: Object.values(row).map(value => Buffer.from(typeof value === 'boolean' ? value ? 't' : 'f' : String(value))) });
        }
        if (sql.startsWith('BEGIN')) status = 'T'; if (['COMMIT', 'ROLLBACK'].includes(sql)) status = 'I';
        connection.emit('commandComplete', { text: sql.startsWith('SELECT') ? 'SELECT 1' : sql.split(' ')[0] });
        connection.emit('readyForQuery', { status });
      };
      if (sql === 'SELECT held') releaseHeld = () => queueMicrotask(finish); else queueMicrotask(finish);
    };
    return pg.Client.prototype.connect.apply(this, args);
  };
  const previous = scope.getTenancyMode(); scope.setTenancyMode('multi'); let store;
  const restore = () => { protocol.Client.prototype.connect = originalConnect; protocol.Client.prototype.query = originalQuery; scope.setTenancyMode(previous); };
  try { store = await connect({ connectionString: 'postgres://synthetic:synthetic@127.0.0.1/synthetic_test', direct: true, displaySettings: true, application_name: 'nightscout-display-settings', max: 1, idleTimeoutMillis: 0 }); }
  catch (error) { restore(); throw error; }
  return { store, calls, clients, release: () => releaseHeld(), async close () { try { await store.end(); } finally { restore(); } } };
}
describe('unselected settings actual-driver protocol custody', function () {
  it('poisons a caught pending-query refusal, drains actual driver work and recovers with a fresh checkout', async function () {
    const f = await snapshotFixture(), tenant = '11111111-1111-4111-8111-111111111111'; let refused;
    try {
      await assert.rejects(f.store.readOnlySnapshot(tenant, async ({ query }) => {
        const first = query('SELECT held');
        try { await query('SELECT pending_second'); } catch (error) { refused = error; }
        f.release(); await first;
        return 'VALUE';
      }), error => error === refused && error.code === 'POSTGRES_SETTINGS_PROTOCOL_REQUIRED');
      assert(!f.calls.includes('SELECT pending_second')); assert(!f.calls.includes('COMMIT')); assert(f.calls.includes('ROLLBACK'));
      assert.equal(f.clients[0]._ending, true);
      assert.equal(await f.store.readOnlySnapshot(tenant, async ({ query }) => { await query('SELECT healthy'); return 'FRESH'; }), 'FRESH');
      assert.equal(f.clients.length, 2); assert.equal(f.calls.filter(sql => sql === 'COMMIT').length, 1);
    } finally { await f.close(); }
  });
  it('accepts completed T only, rejects fabricated clients, and observes dispatch and queue drain', async function () {
    const f = await fixture();
    try {
      assert.throws(() => protocol.assertTransaction(f.client)); await f.begin(); protocol.assertTransaction(f.client);
      const manual = new (require('pg').Client)({ host: 'synthetic-pg', ssl: false });
      manual.readyForQuery = true; assert.throws(() => protocol.assertTransaction(manual));
      const first = f.client.query('SELECT first'), second = f.client.query('SELECT second');
      assert.throws(() => protocol.assertTransaction(f.client)); f.finish('T'); await first;
      assert.throws(() => protocol.assertTransaction(f.client)); f.finish('T'); await second; protocol.assertTransaction(f.client);
      f.client.pipeline = true; assert.throws(() => protocol.assertTransaction(f.client)); f.client.pipeline = false;
    } finally { await f.close(); }
    assert.throws(() => protocol.assertTransaction(f.client));
  });
  it('refuses private Ready gap after ErrorResponse even if a caller forges public flags, and admits rollback only after E', async function () {
    const f = await fixture();
    try {
      await f.begin(); const q = f.client.query('SELECT failure'), rejected = assert.rejects(q, { code: '40001' });
      f.connection.emit('errorMessage', Object.assign(Error('synthetic SQL failure'), { code: '40001' })); await rejected;
      assert.throws(() => protocol.assertTransaction(f.client)); assert.throws(() => protocol.assertRollback(f.client)); assert.throws(() => protocol.assertUnlock(f.client));
      f.client.readyForQuery = true; assert.throws(() => protocol.assertRollback(f.client)); f.client.readyForQuery = false;
      f.connection.emit('readyForQuery', { status: 'E' }); assert.throws(() => protocol.assertTransaction(f.client)); protocol.assertRollback(f.client);
      const rollback = f.client.query('ROLLBACK'); f.finish('I'); await rollback; protocol.assertUnlock(f.client);
      assert.throws(() => protocol.assertTransaction(f.client)); assert.throws(() => protocol.assertRollback(f.client));
      await f.begin(); protocol.assertTransaction(f.client);
    } finally { await f.close(); }
  });
  it('invalidates private T when the automatically dispatched queued query fails before its Ready packet', async function () {
    const f = await fixture();
    try {
      await f.begin(); const first = f.client.query('SELECT first'), second = f.client.query('SELECT queued_failure');
      const rejected = assert.rejects(second, { code: '40001' }); f.finish('T'); await first;
      f.connection.emit('errorMessage', Object.assign(Error('synthetic queued error'), { code: '40001' })); await rejected;
      f.client.readyForQuery = true; assert.throws(() => protocol.assertRollback(f.client)); f.client.readyForQuery = false;
      f.connection.emit('readyForQuery', { status: 'E' }); protocol.assertRollback(f.client);
    } finally { await f.close(); }
  });
  it('rejects replaced transport, dead stream, unknown Ready and an ending client', async function () {
    for (const state of ['replacement', 'destroyed', 'unknown', 'ending']) {
      const f = await fixture();
      try {
        await f.begin(); const stream = f.connection.stream;
        if (state === 'replacement') f.connection.stream = new Stream();
        if (state === 'destroyed') stream.destroyed = true;
        if (state === 'unknown') f.connection.emit('readyForQuery', { status: 'unknown' });
        if (state === 'ending') f.client._ending = true;
        assert.throws(() => protocol.assertTransaction(f.client));
        f.connection.stream = stream; stream.destroyed = false; f.client._ending = false;
      } finally { await f.close(); }
    }
  });
});
