'use strict';
// Source timing boundaries only; no services, listeners or clinical authority.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const diagnostics = require('../lib/diagnostics/m7');
const runtime = require('../lib/server/serve/evaluator-runtime');
const A = '11111111-1111-4111-8111-111111111111';
async function criterion (start = runtime, failure) {
  let clock = 0, revision = 0, service;
  const diag = diagnostics.create({ enabled: true, intervalMs: 60000, clock: () => clock,
    sinkFactory: () => ({ state: () => 'ready', send: (bytes, callback) => { callback(true); return true; }, close () {} }) });
  const previous = diagnostics.time; diagnostics.time = diag.time;
  const value = () => ({ checkpoint: 1, properties: {}, emitted: [], requested: [], signature: { stamp: 1, deleted: 0 } });
  try {
    service = await start({ tenants: [A], now: () => 1000,
      readCurrent: async () => { clock += 13; return { tenant: A, identity: 'a'.repeat(64) }; },
      create: async () => { clock += 17; return {
        evaluate: async () => { clock += 7; if (failure === 'execute') throw new Error('SYNTHETIC_EXECUTOR_REFUSAL'); return value(); },
        evaluateTime: async () => { clock += 3; return value(); }, close () {} }; },
      durable: { begin: async () => { clock += 19; return { clock: '1' }; },
        complete: async (tenant, current) => { clock += 11; if (failure === 'commit') throw new Error('SYNTHETIC_COMMIT_REFUSAL');
          return { pendingAt: null, changed: true, output: { tenant, identity: current.identity,
            outputRevision: ++revision, contentDigest: 'b'.repeat(64), inputCheckpoint: 1, result: current.result } }; } },
      recoveryIntervalMs: 1000, timeIntervalMs: 1000, schedule: () => ({}), cancel () {}, setTimer: () => ({}), clearTimer () {} });
    // The common scheduler now requests durable startup explicitly.
    await service.acquire(A);
    const first = diag.snapshot().durations;
    assert.equal(first['evaluator.execute_acquisition'].count, 1, 'EXECUTOR_CALL_REQUIRED');
    assert.equal(first['evaluator.execute_acquisition'].sumMs, 7, 'EXECUTOR_EXCLUDES_CONFIG_AND_RECEIPT_WAIT');
    assert.equal(first['evaluator.durable_complete'].count, failure === 'execute' ? 0 : 1, 'DURABLE_CALL_REQUIRED');
    assert.equal(first['evaluator.durable_complete'].sumMs, failure === 'execute' ? 0 : 11);
    if (!failure) {
      await service.tick(A);
      const after = diag.snapshot();
      assert.equal(after.durations['evaluator.execute_time'].count, 1, 'TIME_EXECUTOR_CALL_REQUIRED');
      assert.equal(after.durations['evaluator.execute_time'].sumMs, 3);
      assert.equal(after.durations['evaluator.durable_complete'].count, 2);
      assert.equal(after.durations['evaluator.durable_complete'].sumMs, 22);
      assert.equal(after.unknownStages, 0);
      assert.equal(service.health([A]).tenants[0].cycles, 2);
      assert.equal(service.last(A).outputRevision, 2);
      assert(diag.emit(), 'BOUNDED_DIAGNOSTIC_PAYLOAD_STILL_EMITS');
    } else {
      assert.equal(service.last(A), null, 'REFUSED_CALL_CANNOT_PUBLISH');
      assert.equal(service.health([A]).tenants[0].cycles, 0);
    }
  } finally { try { await service?.close(); } finally { diagnostics.time = previous; diag.close(); } }
}
describe('evaluator executor and durable timing boundaries', function () {
  it('separates actual executor calls and durable completion from queue/config/receipt spans', async () => criterion());
  it('ends rejected executor and durable attempts without turning them into completions', async () => {
    await criterion(runtime, 'execute'); await criterion(runtime, 'commit');
  });
  it('detects omitted execution or durable timing and passes after exact restoration', async () => {
    const filename = require.resolve('../lib/server/serve/evaluator-runtime'), source = fs.readFileSync(filename, 'utf8');
    for (const needle of ['finally { endExecute(); }', 'finally { endDurable(); }']) {
      assert.equal(source.split(needle).length, 2);
      const broken = new Module(filename, module); broken.filename = filename; broken.paths = Module._nodeModulePaths(path.dirname(filename));
      broken._compile(source.replace(needle, 'finally { /* omitted timing control */ }'), filename);
      await assert.rejects(criterion(broken.exports), error => error.code === 'ERR_ASSERTION' && error.actual === 0 && error.expected === 1);
    }
    await criterion();
  });
});
