'use strict';
const assert = require('node:assert/strict');
const { create } = require('../lib/tenant-lifecycle/operation-window');
const fixture = require('./fixtures/operation-window-runtime-protocol');
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function owned () {
  return fixture({ leaseSessionCount: 1 }, config => {
    config.pool.options.connectionTimeoutMillis = 20;
    return create(config);
  });
}
describe('Generation observation under control-session pressure', function () {
  it('lets an admitted body finish while the next tenant is reading its generation', async function () {
    const f = owned(), body = deferred(), entered = deferred(), sql = deferred(), sqlEntered = deferred();
    await f.window.ready();
    const first = f.window.run(A, async () => { entered.resolve(); await body.promise; });
    const firstResult = first.then(value => ({ value }), error => ({ error }));
    await entered.promise;
    const query = f.client.query; let block = true;
    f.client.query = async (text, values) => {
      if (text === 'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY' && block) { block = false; sqlEntered.resolve(); await sql.promise; }
      return query(text, values);
    };
    const second = f.window.run(B, () => 2);
    const secondResult = second.then(value => ({ value }), error => ({ error }));
    try {
      await sqlEntered.promise;
      body.resolve();
      await first;
      assert.equal(f.pending.size, 0, 'finishing a body needs no database marker');
      sql.resolve();
      const a = await firstResult, b = await secondResult;
      assert.equal(a.error, undefined); assert.equal(b.error, undefined);
      assert.equal(b.value, 2); assert.equal(f.pending.size, 0);
      await f.window.probe();
    } finally { body.resolve(); sql.resolve(); await firstResult; await secondResult; await f.window.close(); }
  });
  it('invalidates active bodies after control backend loss without creating a marker', async function () {
    const f = owned(), body = deferred(), entered = deferred(); await f.window.ready();
    const running = f.window.run(A, async () => { entered.resolve(); await body.promise; });
    const result = running.then(value => ({ value }), error => ({ error }));
    try {
      await entered.promise;
      f.client.emit('error', Object.assign(new Error('synthetic backend loss'), { code: 'ECONNRESET' }));
      body.resolve(); const failure = await result;
      assert.ok(failure.error); assert.equal(f.pending.size, 0);
      await assert.rejects(f.window.probe(), { code: 'LIFECYCLE_WINDOW_SESSION_LOST' });
      assert.equal(f.log.some(row => row[0] === 'release' && row[1]), true);
    } finally { body.resolve(); await result; await f.window.close().catch(() => {}); }
  });
});
