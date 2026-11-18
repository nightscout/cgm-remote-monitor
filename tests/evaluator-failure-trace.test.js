'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fixture = require('./fixtures/operation-window-runtime-protocol');
const runtime = require('../lib/server/serve/evaluator-runtime');
const contexts = require('../lib/server/serve/evaluator-job-context');
const diagnostic = require('../lib/diagnostics/evaluator-failure');
const A = '11111111-1111-4111-8111-111111111111';
const prefix = 'EVALUATOR_FAILURE_TRACE ';
const hash = value => createHash('sha256').update(value).digest('hex');

async function run(limit, durable = false) {
  const previous = process.env.NS_EVALUATOR_FAILURE_TRACE_LIMIT;
  if (limit === undefined) delete process.env.NS_EVALUATOR_FAILURE_TRACE_LIMIT;
  else process.env.NS_EVALUATOR_FAILURE_TRACE_LIMIT = String(limit);
  const lines = [], original = process.stdout.write;
  process.stdout.write = function (line, ...args) {
    if (typeof line === 'string' && line.startsWith(prefix)) {
      lines.push(JSON.parse(line.slice(prefix.length)));
      return true;
    }
    return original.call(this, line, ...args);
  };
  const options = {}, f = fixture(options);
  let mode, service;
  const refuse = () => {
    if (mode === 'known') throw new Error('sensitive test text', { cause: new Error('EVALUATOR_COMPLETION_CONFIG_CHANGED') });
    if (mode === 'unknown') throw Object.assign(new Error('sensitive test text'), { code:'PRIVATE_TENANT_INFO' });
  };
  const output = () => {
    if (!durable) refuse();
    return { checkpoint:0, properties:{} };
  };
  try {
    service = await runtime({ tenants:[A], operationWindow:f.window, jobContext:contexts.create('clinical'),
      ...(durable ? { durable:{
        begin:async()=>({ clock:1 }),
        complete:async()=>{ refuse(); return { changed:true, output:{ outputRevision:1, contentDigest:'f'.repeat(64) } }; }
      } } : {}),
      recoveryIntervalMs:60000, timeIntervalMs:60000, schedule:()=>1, cancel(){}, setTimer:()=>1, clearTimer(){},
      readCurrent:async tenant=>({ tenant, identity:'a'.repeat(64) }),
      create:async()=>({ evaluate:output, evaluateTime:output, close(){} }) });
    if (durable) await service.acquire(A);
    const runtimeId = service.health().runtimeId;
    mode = 'known';
    await service.tick(A);
    mode = 'unknown';
    await service.acquire(A);
    mode = undefined;
    await service.acquire(A);
    options.held = false;
    await service.acquire(A);
    const progress = service.health([A]).tenants[0].progress;
    await service.close();
    return { lines, runtimeId, progress };
  } finally {
    try { await service?.close(); await f.window.close(); }
    finally {
      process.stdout.write = original;
      if (previous === undefined) delete process.env.NS_EVALUATOR_FAILURE_TRACE_LIMIT;
      else process.env.NS_EVALUATOR_FAILURE_TRACE_LIMIT = previous;
    }
  }
}

describe('evaluator failed-completion trace', function () {
  it('attributes both real increments, preserves credit, and redacts unapproved errors and identifiers', async function () {
    const off = await run(), on = await run(10);
    assert.deepEqual(off.lines, []);
    for (const result of [off, on]) {
      assert.equal(result.progress.failedCompletions, 3);
      assert.equal(result.progress.completedAcquisitions, 2);
      assert.equal(result.progress.completedTimeCycles, 0);
    }
    assert.equal(on.lines[0].event, 'enabled');
    const failures = on.lines.filter(line => line.event === 'failed-completion');
    assert.deepEqual(failures.map(r => [r.sequence, r.countAfter, r.site, r.selected, r.phase, r.stage]), [
      [1, 1, 'no-credit', 'time-only', 'credit', 'evaluate'],
      [2, 2, 'no-credit', 'acquisition', 'credit', 'evaluate'],
      [3, 3, 'dispatch-exception', 'acquisition', 'window-entry', null]
    ]);
    assert.equal(failures[0].inner, 'EVALUATOR_COMPLETION_CONFIG_CHANGED');
    assert.equal(failures[1].inner, 'unclassified');
    assert.equal(failures[2].exception, 'LIFECYCLE_WINDOW_SUSPENDED');
    for (const row of failures) {
      assert.equal(row.runtime, hash(on.runtimeId));
      assert.equal(row.tenantWitness, hash(on.runtimeId + '\0' + A));
      assert.equal(row.effectiveKind, row.selected);
      assert.equal(row.current, true);
      assert.equal(row.borrowed, false);
      assert.equal(row.closed, false);
      assert.equal(row.completedGeneration, null);
      assert(Number.isSafeInteger(row.dispatchGeneration));
      assert(Number.isSafeInteger(row.currentGeneration));
    }
    assert.equal(failures[0].cycleGeneration, failures[0].currentGeneration);
    assert.equal(failures[2].cycleGeneration, null);
    const serialized = JSON.stringify(on.lines);
    for (const privateValue of [on.runtimeId,A,'sensitive test text','PRIVATE_TENANT_INFO']) assert(!serialized.includes(privateValue));
    assert.deepEqual(on.lines.slice(-1).map(r => [r.observed,r.written,r.omitted]), [[3,3,0]]);
  });
  it('retains the original durable refusal after the runtime converts it to a time-cycle refusal', async function () {
    const { lines, progress } = await run(10, true);
    const first = lines.find(row => row.event === 'failed-completion');
    assert.equal(first.site, 'no-credit');
    assert.equal(first.stage, 'durable-complete');
    assert.equal(first.inner, 'EVALUATOR_COMPLETION_CONFIG_CHANGED');
    assert.equal(first.stateCode, 'EVALUATOR_TIME_REFUSED');
    assert.equal(progress.failedCompletions, 3);
  });
  it('reports truncation at the configured event count and preserves later failures', async function () {
    const { lines, progress } = await run(1);
    assert.deepEqual(lines.map(row => row.event), ['enabled','failed-completion','truncated','summary']);
    assert.equal(lines[2].firstOmitted, 2);
    assert.equal(lines[3].omitted, 2);
    assert.equal(progress.failedCompletions, 3);
    assert.throws(() => diagnostic.create('test',{NS_EVALUATOR_FAILURE_TRACE_LIMIT:'Infinity'}), /positive safe integer/);
  });
});
