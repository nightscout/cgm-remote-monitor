'use strict';
const assert = require('node:assert/strict');
const fixture = require('./fixtures/operation-window-runtime-protocol');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const count = (f, text) => f.log.filter(row => row[0].includes(text)).length;
const barrier = () => { let release; const wait = new Promise(resolve => { release = resolve; }); return { wait, release }; };
const turn = () => new Promise(resolve => setImmediate(resolve));

// Per-request lock reuse assertions are retired. One durable participation
// protects local bodies; lower physical transactions retain their own locks.
describe('Tenant participation warm path and suspended drain (source protocol)', function () {
  it('adds no lifecycle SQL for overlapping or sequential warm bodies and releases the cold lock', async function () {
    const f = fixture({ leaseSessionCount: 1 }), body = barrier(), entered = barrier();
    const first = f.window.run(A, async () => { entered.release(); await body.wait; });
    try {
      await entered.wait;
      const before = f.log.length, marker = f.window.inflight(A);
      assert.equal(marker.length, 1);
      assert.equal(count(f, 'pg_try_advisory_lock_shared'), 1);
      assert.equal(count(f, 'pg_advisory_unlock_shared'), 1, 'no request body retains an outer database lock');
      await f.window.run(A, () => 2);
      assert.equal(f.log.length, before, 'overlap creates no lane work or marker SQL');
      body.release(); await first;
      await f.window.run(A, () => 3);
      assert.equal(f.log.length, before, 'sequential bodies also reuse participation');
      assert.deepEqual(f.window.inflight(A), marker);
      assert.deepEqual([...f.pending.values()], [false]);
    } finally { body.release(); await first; await f.window.close(); }
    assert.deepEqual([...f.pending.values()], [true]);
  });
  it('opens one participation for concurrent first bodies and keeps tenants separate', async function () {
    const f = fixture({ leaseSessionCount: 1 });
    try {
      await Promise.all(Array.from({ length: 20 }, () => f.window.run(A, () => {})));
      assert.equal(count(f, 'INSERT INTO'), 1);
      await f.window.run(B, () => {});
      assert.equal(count(f, 'INSERT INTO'), 2);
      assert.notDeepEqual(f.window.inflight(A), f.window.inflight(B));
    } finally { await f.window.close(); }
  });
  it('an active operations census does not retire participation', async function () {
    const f = fixture({ leaseSessionCount: 1 });
    try {
      await f.window.run(A, () => {}); await f.window.drainTenant(A);
      await f.window.run(A, () => {});
      assert.equal(count(f, 'INSERT INTO'), 1);
      assert.equal(count(f, 'UPDATE '), 0);
      await assert.rejects(f.window.invalidateTenant(A), { code: 'LIFECYCLE_WINDOW_DRAIN_REQUIRED' });
    } finally { await f.window.close(); }
  });
  it('suspended drain closes admission, waits for real bodies, and permits fresh-generation reopening', async function () {
    const options = { leaseSessionCount: 1 }, f = fixture(options), body = barrier(), entered = barrier();
    const running = f.window.run(A, async () => { entered.release(); await body.wait; return 7; });
    try {
      await entered.wait;
      const marker = f.window.inflight(A);
      options.phase = 'suspended'; options.generation = '2';
      await f.window.drainTenant(A);
      await assert.rejects(f.window.run(A, () => assert.fail('new body during drain')), { code: 'LIFECYCLE_WINDOW_SUSPENDED' });
      await assert.rejects(f.window.invalidateTenant(A), { code: 'LIFECYCLE_WINDOW_DRAIN_REQUIRED' });
      assert.deepEqual(f.window.inflight(A), marker);
      assert.equal(count(f, 'UPDATE '), 0, 'held response cannot be guessed complete');
      body.release(); assert.equal(await running, 7);
      await f.window.invalidateTenant(A);
      assert.deepEqual(f.window.inflight(A), []);
      assert.deepEqual([...f.pending.values()], [true]);
      options.phase = 'active';
      await f.window.run(A, () => assert.equal(f.window.currentGeneration(A), '2'));
      assert.equal(count(f, 'INSERT INTO'), 2);
    } finally { body.release(); await running; await f.window.close(); }
  });
  it('suspending A drains its participant while B continues without another registration', async function () {
    const options = { leaseSessionCount: 1, phases: {} }, f = fixture(options);
    try {
      await f.window.run(A, () => {}); await f.window.run(B, () => {});
      options.phases[A] = 'suspended'; await f.window.drainTenant(A); await f.window.invalidateTenant(A);
      const before = f.log.length;
      await f.window.run(B, () => 9);
      assert.equal(f.log.length, before);
      assert.equal(f.window.inflight(B).length, 1);
    } finally { await f.window.close(); }
  });
  for (const event of ['error', 'end']) it('retains durable pending participation and invalidates active bodies after ' + event, async function () {
    const f = fixture({ leaseSessionCount: 1 }), body = barrier(), entered = barrier(); let invalidated = 0;
    const running = f.window.run(A, async () => { entered.release(); await body.wait; }, { onInvalidated: () => { invalidated++; } });
    const settled = running.catch(error => error);
    try {
      await entered.wait;
      const marker = f.window.inflight(A);
      const loss = new Error('synthetic owner loss');
      f.client.emit(event, loss);
      await assert.rejects(f.window.run(A, () => {}), { code: 'LIFECYCLE_WINDOW_SESSION_LOST' });
      assert.equal(invalidated, 1);
      await f.window.drainTenant(A);
      assert.deepEqual(f.window.inflight(A), marker, 'clearance must still see actual failed-owner bodies');
      body.release();
      const failure = await settled;
      if (event === 'error') assert.equal(failure, loss);
      else assert.equal(failure.code, 'LIFECYCLE_WINDOW_SESSION_LOST');
      await turn();
      assert.deepEqual([...f.pending.values()], [false]);
      assert.equal(count(f, 'UPDATE '), 0);
    } finally { body.release(); await settled; await f.window.close().catch(() => {}); }
  });
  it('keeps an uncertain registration without entering any body or silently replacing its owner', async function () {
    const f = fixture({ leaseSessionCount: 1 });
    const query = f.client.query; let inserted = false;
    const loss = Object.assign(new Error('synthetic registration COMMIT reply loss'), { code: 'SYNTHETIC_COMMIT_LOSS' });
    f.client.query = async (text, values) => {
      const result = await query(text, values);
      if (typeof text === 'string' && text.startsWith('INSERT INTO')) inserted = true;
      if (inserted && text === 'COMMIT') throw loss;
      return result;
    };
    await assert.rejects(f.window.run(A, () => assert.fail('uncertain admission body')), error => error === loss || error.cause === loss);
    assert.deepEqual([...f.pending.values()], [false]);
    await assert.rejects(f.window.run(A, () => assert.fail('replacement body')), { code: 'LIFECYCLE_WINDOW_SESSION_LOST' });
    await f.window.close().catch(() => {});
  });
  it('refuses successful drain acknowledgement after an uncertain completion COMMIT', async function () {
    const options = { leaseSessionCount: 1 }, f = fixture(options);
    await f.window.run(A, () => {});
    const query = f.client.query; let finishing = false;
    const loss = Object.assign(new Error('synthetic completion COMMIT reply loss'), { code: 'SYNTHETIC_FINISH_LOSS' });
    f.client.query = async (text, values) => {
      const result = await query(text, values);
      if (typeof text === 'string' && text.startsWith('UPDATE ')) finishing = true;
      if (finishing && text === 'COMMIT') throw loss;
      return result;
    };
    options.phase = 'suspended'; await f.window.drainTenant(A);
    await assert.rejects(f.window.invalidateTenant(A));
    assert.deepEqual([...f.pending.values()], [true], 'protocol model applied UPDATE but its COMMIT outcome was not acknowledged');
    await assert.rejects(f.window.run(A, () => {}), { code: 'LIFECYCLE_WINDOW_SESSION_LOST' });
    await f.window.close().catch(() => {});
  });
  it('refuses a changed generation on a physical lower transaction within a warm body', async function () {
    const options = { leaseSessionCount: 1 }, f = fixture(options);
    try {
      await f.window.run(A, async () => {
        const lease = await f.window.acquireClient(f.client, A);
        try {
          options.generation = '2';
          await assert.rejects(f.window.assertClient(f.client, A, lease), { code: 'LIFECYCLE_WINDOW_BINDING_CHANGED' });
        } finally { await lease.close(); }
      });
    } finally { await f.window.close(); }
  });
  it('detects injected request-path SQL and restores zero-SQL warm bodies', async function () {
    const fs = require('node:fs'), vm = require('node:vm');
    const file = require.resolve('../lib/tenant-lifecycle/operation-window'), text = fs.readFileSync(file, 'utf8');
    const needle = 'const state = { tenant, generation: participant.scope.generation,';
    assert(text.includes(needle));
    const output = { exports: {} };
    const broken = text.replace(needle, "await owner.client.query('SELECT 1');\n    " + needle);
    vm.runInThisContext('(function(require,module,exports){' + broken + '\n})', { filename: file })(require('node:module').createRequire(file), output, output.exports);
    async function exercise (create) {
      const f = fixture({ leaseSessionCount: 1 }, create);
      try {
        await f.window.run(A, () => {}); const before = f.log.length;
        await f.window.run(A, () => {});
        assert.equal(f.log.length, before, 'WARM_LIFECYCLE_SQL');
      } finally { await f.window.close(); }
    }
    await assert.rejects(exercise(output.exports.create), /WARM_LIFECYCLE_SQL/);
    await exercise();
  });
  it('detects a missing process drain barrier and restores the control', async function () {
    const fs = require('node:fs'), vm = require('node:vm');
    const file = require.resolve('../lib/tenant-lifecycle/operation-window'), text = fs.readFileSync(file, 'utf8');
    const needle = "if (row.phase === 'suspended') participant.accepting = false;";
    assert(text.includes(needle));
    const output = { exports: {} };
    vm.runInThisContext('(function(require,module,exports){' + text.replace(needle, "if (row.phase === 'suspended') participant.accepting = true;") + '\n})', { filename: file })(require('node:module').createRequire(file), output, output.exports);
    async function exercise (create) {
      const options = { leaseSessionCount: 1 }, f = fixture(options, create);
      try {
        await f.window.run(A, () => {}); options.phase = 'suspended'; await f.window.drainTenant(A);
        await assert.rejects(f.window.run(A, () => {}), { code: 'LIFECYCLE_WINDOW_SUSPENDED' });
      } finally { await f.window.close(); }
    }
    await assert.rejects(exercise(output.exports.create), /Missing expected rejection/);
    await exercise();
  });
});
