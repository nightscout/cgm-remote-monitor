'use strict';
const assert = require('node:assert/strict');
const stages = require('../lib/diagnostics/clinical-stages');
const ids = Array.from({ length: 200 }, (_, i) => String(i).padStart(8, '0') + '-1111-4111-8111-111111111111');

describe('opt-in clinical stage records', function () {
  it('is off unless configured and refuses a malformed fraction', function () {
    assert.equal(stages.create({}).enabled, false);
    assert.equal(stages.create({ fraction: '' }).record('evaluator.receipt', { tenant: ids[0], clock: '1' }), false);
    for (const fraction of ['0', '-1', '2', 'x']) assert.throws(() => stages.create({ fraction }), /fraction/);
  });

  it('samples the same tenants in every process so records can be joined', function () {
    const lines = [[], []];
    const a = stages.create({ fraction: '0.25', write: line => lines[0].push(line) });
    const b = stages.create({ fraction: '0.25', write: line => lines[1].push(line) });
    for (const tenant of ids) { a.record('evaluator.receipt', { tenant, clock: '7' }); b.record('realtime.frame', { tenant, outputRevision: 3, sent: 1, held: 0 }); }
    const tenantsOf = rows => rows.map(line => JSON.parse(line.slice('CLINICAL_STAGE '.length)).tenant);
    assert.deepEqual(tenantsOf(lines[0]), tenantsOf(lines[1]), 'SAMPLE_NOT_STABLE_ACROSS_PROCESSES');
    assert(lines[0].length > 20 && lines[0].length < 90, 'sample share is roughly the configured fraction: ' + lines[0].length);
  });

  it('records versions and counts only, caps the rate and counts drops', function () {
    const out = [];
    let now = 5000;
    const t = stages.create({ fraction: '1', maxPerSecond: 3, write: line => out.push(line), now: () => now });
    assert.equal(t.record('evaluator.complete', { tenant: ids[0], covered: '9', outputRevision: 4, changed: true }), true);
    assert.equal(t.record('evaluator.complete', { tenant: ids[0], frame: { sgv: 100 } }), false, 'NON_SCALAR_FIELD_REFUSED');
    assert.equal(t.record('unknown.stage', { tenant: ids[0] }), false);
    t.record('evaluator.receipt', { tenant: ids[1], clock: '1' }); t.record('evaluator.receipt', { tenant: ids[2], clock: '1' });
    assert.equal(t.record('evaluator.receipt', { tenant: ids[3], clock: '1' }), false, 'RATE_CAP');
    now += 1000;
    assert.equal(t.record('evaluator.receipt', { tenant: ids[3], clock: '1' }), true);
    assert.deepEqual(t.stats(), { enabled: true, written: 4, dropped: 1, refused: 2 });
    assert.deepEqual(JSON.parse(out[0].slice('CLINICAL_STAGE '.length)), { stage: 'evaluator.complete', at: 5000, tenant: ids[0], covered: '9', outputRevision: 4, changed: true });
  });

  it('emits the evaluator completion join record from the actual runtime', async function () {
    const keys = ['../lib/diagnostics/clinical-stages', '../lib/server/serve/evaluator-runtime'].map(name => require.resolve(name));
    const saved = process.env.NS_CLINICAL_STAGE_TRACE, write = process.stdout.write;
    const lines = [];
    keys.forEach(key => delete require.cache[key]);
    process.env.NS_CLINICAL_STAGE_TRACE = '1';
    process.stdout.write = function (chunk, ...rest) { if (String(chunk).startsWith('CLINICAL_STAGE ')) { lines.push(String(chunk)); return true; } return write.call(this, chunk, ...rest); };
    try {
      const start = require('../lib/server/serve/evaluator-runtime');
      const runtime = await start({ tenants: [ids[0]], externalRecovery: true, recoveryIntervalMs: 1000, timeIntervalMs: 60000,
        readCurrent: async tenant => ({ tenant, identity: 'a'.repeat(64) }),
        create: async () => ({ async evaluate () { return { checkpoint: 1, properties: {}, emitted: [], requested: [] }; }, close () {} }),
        schedule: () => ({}), cancel () {}, now: () => 100,
        durable: { pendingMs: 1000, async begin () { return { clock: '12' }; },
          async complete (tenant, { result, identity }) { return { changed: true, pendingAt: null, output: { tenant, identity, outputRevision: 5, contentDigest: 'b'.repeat(64), result } }; } } });
      await runtime.acquire(ids[0]);
      await runtime.close();
    } finally {
      process.stdout.write = write;
      if (saved === undefined) delete process.env.NS_CLINICAL_STAGE_TRACE; else process.env.NS_CLINICAL_STAGE_TRACE = saved;
      keys.forEach(key => delete require.cache[key]);
    }
    const rows = lines.map(line => JSON.parse(line.slice('CLINICAL_STAGE '.length)));
    assert.deepEqual(rows.map(({ at, ...row }) => row), [{ stage: 'evaluator.complete', tenant: ids[0], covered: '12', outputRevision: 5, changed: true }], 'COMPLETION_STAGE_MISSING');
  });
});
