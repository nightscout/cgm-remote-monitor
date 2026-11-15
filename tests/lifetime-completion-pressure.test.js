'use strict';
const assert = require('node:assert/strict');
const { create } = require('../lib/tenant-lifecycle/operation-window');
const fixture = require('./fixtures/operation-window-runtime-protocol');
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const later = ms => new Promise(resolve => setTimeout(resolve, ms));
function owned () {
  return fixture({ leaseSessionCount: 1 }, config => {
    config.pool.options.connectionTimeoutMillis = 20;
    return create(config);
  });
}
describe('Registered operation completion under lifetime-lane pressure', function () {
  it('drains a registered completion after a queued admission deadline without poisoning a healthy backend', async function () {
    const f = owned(), body = deferred(), entered = deferred(), sql = deferred(), sqlEntered = deferred();
    await f.window.ready();
    const first = f.window.run(A, async () => { entered.resolve(); await body.promise; });
    const firstResult = first.then(value => ({ value }), error => ({ error }));
    await entered.promise;
    const query = f.client.query; let block = true;
    f.client.query = async (text, values) => {
      if (text === 'BEGIN' && block) { block = false; sqlEntered.resolve(); await sql.promise; }
      return query(text, values);
    };
    const second = f.window.run(B, () => 2);
    const secondResult = second.then(value => ({ value }), error => ({ error }));
    try {
      await sqlEntered.promise; body.resolve(); await later(40);
      assert.equal(f.log.some(row => row[0] === 'release' && row[1]), false, 'a queue wait must not evict a healthy owner');
      assert.deepEqual([...f.pending.values()], [false], 'the unfinished marker remains until completion executes');
      sql.resolve();
      const a = await firstResult, b = await secondResult;
      assert.equal(a.error, undefined); assert.equal(b.error, undefined);
      assert.equal(b.value, 2); assert.deepEqual([...f.pending.values()], [true, true]);
      await f.window.probe();
    } finally { body.resolve(); sql.resolve(); await firstResult; await secondResult; await f.window.close(); }
  });
  it('still invalidates active bodies and retains unfinished durable markers after actual backend loss', async function () {
    const f = owned(), body = deferred(), entered = deferred(); await f.window.ready();
    const running = f.window.run(A, async () => { entered.resolve(); await body.promise; });
    const result = running.then(value => ({ value }), error => ({ error }));
    try {
      await entered.promise;
      f.client.emit('error', Object.assign(new Error('synthetic backend loss'), { code: 'ECONNRESET' }));
      body.resolve(); const failure = await result;
      assert.ok(failure.error); assert.deepEqual([...f.pending.values()], [false]);
      await assert.rejects(f.window.probe(), { code: 'LIFECYCLE_WINDOW_SESSION_LOST' });
      assert.equal(f.log.some(row => row[0] === 'release' && row[1]), true);
    } finally { body.resolve(); await result; await f.window.close(); }
  });
});
