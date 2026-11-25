'use strict';
const assert = require('node:assert/strict');
const fixture = require('./fixtures/operation-window-runtime-protocol');
const A = '11111111-1111-4111-8111-111111111111';
const barrier = () => { let release; const wait = new Promise(resolve => { release = resolve; }); return { wait, release }; };

describe('Generation-scoped serving without process participation', function () {
  it('allows invalidation while an application response is held and checks every later SQL effect', async function () {
    const options = { generation: '1' }, f = fixture(options);
    const entered = barrier(), release = barrier();
    const pending = f.window.run(A, async () => {
      assert.equal(f.window.currentGeneration(A), '1');
      entered.release(); await release.wait;
      await assert.rejects(async () => {
        const lease = await f.window.acquireClient(f.client, A);
        try { await f.window.assertClient(f.client, A, lease); } finally { lease.close(); }
      }, { code: 'LIFECYCLE_WINDOW_SUSPENDED' });
      return 'committed response';
    });
    try {
      await entered.wait;
      options.phase = 'suspended';
      assert.equal(f.pending.size, 0, 'held HTTP response has no process participation record');
      await assert.rejects(f.window.run(A, () => {}), { code: 'LIFECYCLE_WINDOW_SUSPENDED' });
      options.phase = 'active'; options.generation = '2';
      assert.equal(await f.window.run(A, () => f.window.currentGeneration(A)), '2');
      release.release();
      assert.equal(await pending, 'committed response');
    } finally { release.release(); await pending.catch(() => {}); await f.window.close(); }
  });
});
