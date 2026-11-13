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
describe('unselected settings actual-driver protocol custody', function () {
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
