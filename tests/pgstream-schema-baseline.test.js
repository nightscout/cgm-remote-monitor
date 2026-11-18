'use strict';
// Decision stable-evaluator-runtime: the startup schema baseline. Recorded
// statement port; PostgreSQL semantics of the three statements are named in the
// module and exercised by the owned native fixture, not here.
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), { createRequire } = require('node:module');
const baseline = require('../lib/pgstream/schema-baseline');
const fake = require('./lib/schema-baseline-fake');
const turn = () => new Promise(resolve => setImmediate(resolve));

function port (options = {}) {
  const calls = [];
  return { calls, read: (sql, values) => { const row = fake.answer(sql, values, { ...options, calls }); if (!row) throw new Error('UNEXPECTED_SQL'); return row; } };
}

describe('pgstream startup schema baseline', function () {
  it('acknowledges positions at or before the baseline and refuses the first later one permanently', async () => {
    const p = port({ position: '1/40' }), b = baseline.create({ read: p.read, timeoutMs: 1000 });
    await b.capture();
    assert.deepEqual(p.calls, ['position', 'snapshot', 'running']);
    for (const position of ['0/FFFFFFFF', '1/3F', '1/40']) assert.equal(await b.observe(position), 'covered');
    assert.equal(await b.observe('1/41'), 'after');
    assert.equal(await b.observe('0/10'), 'after', 'TERMINAL_IS_PERMANENT');
    assert.deepEqual(b.stats(), { phase: 'terminal', baseline: '1/40', acknowledged: 3, startupAcknowledged: 0, repeated: 0, terminalPosition: '1/41' });
  });
  it('treats an already-acknowledged position as a repeated no-op', async () => {
    const b = baseline.create({ read: port({ position: '0/40' }).read, timeoutMs: 1000 });
    await b.capture();
    assert.equal(await b.observe('0/30'), 'covered'); assert.equal(await b.observe('0/30'), 'repeated'); assert.equal(await b.observe('0/20'), 'repeated');
    assert.equal(await b.observe('0/40'), 'covered');
    assert.deepEqual([b.stats().acknowledged, b.stats().repeated], [2, 2]);
  });
  it('acknowledges events received before capture as committed before the position', async () => {
    const b = baseline.create({ read: port({ position: '0/10' }).read, timeoutMs: 1000 });
    assert.equal(await b.observe('5/0'), 'startup'); assert.equal(await b.observe('5/0'), 'repeated');
    await b.capture(); assert.equal(await b.observe('0/11'), 'after');
    assert.equal(b.stats().startupAcknowledged, 1);
  });
  it('refuses an unparseable or missing position once a baseline exists', async () => {
    for (const position of [undefined, null, '', 'nonsense', '123456789/0']) {
      const b = baseline.create({ read: port().read, timeoutMs: 1000 }); await b.capture();
      assert.equal(await b.observe(position), 'after', String(position));
      assert.equal(b.stats().terminalPosition, null);
    }
  });
  it('compares an event arriving while the position is read against that position', async () => {
    let resolve; const value = new Promise(done => { resolve = done; });
    const b = baseline.create({ read: port({ position: () => value }).read, timeoutMs: 1000 });
    const capturing = b.capture(); await turn();
    const early = b.observe('0/41'), covered = b.observe('0/40');
    resolve('0/40'); await capturing;
    assert.equal(await covered, 'covered'); assert.equal(await early, 'after');
  });
  it('waits for every transaction in progress at the position before startup verification may begin', async () => {
    let running = 2, sleeps = 0;
    const b = baseline.create({ read: port({ running: () => running }).read, timeoutMs: 1000, sleep: async () => { sleeps++; if (sleeps === 2) running = 0; } });
    await b.capture();
    assert.equal(sleeps, 2); assert.equal(b.stats().phase, 'established');
  });
  it('refuses startup when in-progress transactions do not settle inside the bound, and fails closed after', async () => {
    let clock = 0;
    const b = baseline.create({ read: port({ running: () => 1 }).read, timeoutMs: 100, now: () => clock, sleep: async () => { clock += 60; } });
    await assert.rejects(b.capture(), { code: 'PGSTREAM_SCHEMA_BASELINE_UNSETTLED' });
    assert.equal(await b.observe('0/1'), 'after', 'FAILED_CAPTURE_REFUSES');
    await assert.rejects(b.capture(), { code: 'PGSTREAM_SCHEMA_BASELINE_ALREADY_CAPTURED' });
  });
  it('refuses malformed position and snapshot rows', async () => {
    await assert.rejects(baseline.create({ read: async () => ({ rows: [{ position: 'x' }] }), timeoutMs: 10 }).capture(), { code: 'PGSTREAM_SCHEMA_BASELINE_REFUSED' });
    await assert.rejects(baseline.create({ read: async sql => sql.includes('insert_lsn') ? { rows: [{ position: '0/1' }] } : { rows: [] }, timeoutMs: 10 }).capture(), { code: 'PGSTREAM_SCHEMA_BASELINE_REFUSED' });
    assert.throws(() => baseline.create({ read: () => {}, timeoutMs: 0 }), TypeError);
  });
  it('control: skipping the visibility wait establishes the baseline with transactions in progress; restored source waits', async () => {
    const file = require.resolve('../lib/pgstream/schema-baseline'), text = fs.readFileSync(file, 'utf8');
    const start = text.indexOf('      const deadline = now() + timeoutMs;'), end = text.indexOf("      phase = 'established';", start);
    assert(start > 0 && end > start);
    const output = { exports: {} };
    vm.runInThisContext('(function(require,module,exports){' + text.slice(0, start) + text.slice(end) + '\n})', { filename: file })(createRequire(file), output, output.exports);
    async function criterion (module) {
      let running = 1, settled = false;
      const b = module.create({ read: port({ running: () => running }).read, timeoutMs: 1000, sleep: async () => { running = 0; } });
      const capture = b.capture().then(() => { settled = true; });
      await capture;
      assert.equal(settled && running, 0, 'BASELINE_MUST_WAIT_FOR_IN_PROGRESS_TRANSACTIONS');
    }
    await assert.rejects(criterion(output.exports), /BASELINE_MUST_WAIT_FOR_IN_PROGRESS_TRANSACTIONS/);
    await criterion(baseline);
  });
});
