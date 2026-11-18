'use strict';
// Decision outcome-evaluator-gate (source half): every failed completion
// carries one closed reason. Real runtime and operation window over the
// recording window protocol; synthetic clinical component and worker ports.
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), { createRequire } = require('node:module');
const fixture = require('./fixtures/operation-window-runtime-protocol');
const runtime = require('../lib/server/serve/evaluator-runtime');
const contexts = require('../lib/server/serve/evaluator-job-context');
const reasons = require('../lib/server/serve/evaluator-failure-reasons');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const prefix = 'EVALUATOR_FAILURE_TRACE ';
const fail = code => Object.assign(new Error(code), { code });

function capture () {
  const lines = [], original = process.stdout.write, previous = process.env.NS_EVALUATOR_FAILURE_TRACE_LIMIT;
  process.env.NS_EVALUATOR_FAILURE_TRACE_LIMIT = '20';
  process.stdout.write = function (line, ...args) {
    if (typeof line === 'string' && line.startsWith(prefix)) { lines.push(JSON.parse(line.slice(prefix.length))); return true; }
    return original.call(this, line, ...args);
  };
  return { lines, restore () {
    process.stdout.write = original;
    if (previous === undefined) delete process.env.NS_EVALUATOR_FAILURE_TRACE_LIMIT; else process.env.NS_EVALUATOR_FAILURE_TRACE_LIMIT = previous;
  } };
}

// One healthy acquisition first (it also joins the runtime's boot work), then
// exactly one armed dispatch. The result is the armed dispatch's delta.
async function arm ({ fault, createFault, windowOptions = {}, before, impl = runtime }) {
  const trace = capture(), f = fixture({ trustedWorker: true, ...windowOptions });
  const worker = { available: true, readerAvailable: true, platformReady: true, generation: 1, invalidation: null };
  let service, armed = false, identity = 'a'.repeat(64);
  try {
    await f.window.ready();
    service = await impl({ tenants: [A], operationWindow: f.window, jobContext: contexts.create('clinical'),
      recoveryIntervalMs: 60000, timeIntervalMs: 60000, schedule: () => 1, cancel () {}, setTimer: () => 1, clearTimer () {},
      workerState: () => ({ ...worker }),
      readCurrent: async tenant => ({ tenant, identity }),
      create: async () => {
        if (armed && createFault) { armed = false; await createFault(); }
        return { evaluate: async () => { if (armed) { armed = false; await fault?.({ worker, window: f.window }); } return { checkpoint: 0, properties: {} }; },
          evaluateTime: async () => ({ checkpoint: 0, properties: {} }), close () {} };
      } });
    await service.acquire(A);
    const first = service.health([A]).tenants[0].progress;
    assert.equal(first.failedCompletions, 0, 'HEALTHY_PRELUDE');
    await before?.({ worker, window: f.window, f });
    armed = !!(fault || createFault); if (createFault) identity = 'b'.repeat(64);
    await service.acquire(A);
    const last = service.health([A]).tenants[0].progress;
    await service.acquire(A);
    const resolved = service.health([A]).tenants[0].progress;
    await service.close();
    const delta = Object.fromEntries(Object.keys(last.failureReasons).map(key => [key, last.failureReasons[key] - first.failureReasons[key]]));
    return { first, last, resolved, delta, failed: last.failedCompletions - first.failedCompletions, credited: last.completedAcquisitions - first.completedAcquisitions,
      failures: trace.lines.filter(row => row.event === 'failed-completion') };
  } finally { trace.restore(); await service?.close(); await f.window.close(); }
}
const only = (result, reason) => {
  assert.equal(result.failed, 1); assert.equal(result.credited, 0);
  const expected = reasons.empty(); expected[reason] = 1;
  assert.deepEqual(result.delta, expected, 'REASON_' + reason);
};

describe('typed failed-completion reasons from their own fault arms', function () {
  it('a healthy dispatch earns credit and no reason', async () => {
    const result = await arm({});
    assert.equal(result.failed, 0); assert.equal(result.credited, 1);
    assert.deepEqual(result.last.failureReasons, reasons.empty()); assert.deepEqual(result.failures, []);
  });
  // The worker-recheck guard: one public error, independent predicates recorded.
  for (const [name, change, reason, predicate] of [
    ['reader unavailable', w => Object.assign(w, { available: false, readerAvailable: false, generation: 2, invalidation: 'query-refusal' }), 'worker-unavailable',
      { readerAvailable: false, platformReady: true, generationMatch: false, invalidation: 'query-refusal' }],
    ['reader available at a changed generation', w => Object.assign(w, { generation: 2, invalidation: 'verify-refusal' }), 'worker-generation',
      { readerAvailable: true, platformReady: true, generationMatch: false, invalidation: 'verify-refusal' }],
    ['metadata healthy but platform verification not ready', w => Object.assign(w, { available: false, platformReady: false }), 'platform-unready',
      { readerAvailable: true, platformReady: false, generationMatch: true, invalidation: null }]
  ]) it('worker recheck: ' + name + ' -> ' + reason, async () => {
    const result = await arm({ fault: ({ worker }) => change(worker) }), { failures } = result;
    only(result, reason);
    assert(failures.length >= 1, 'ARMED_FAILURE_TRACED'); assert.equal(failures[0].stage, 'worker-recheck'); assert.equal(failures[0].site, 'no-credit');
    assert.equal(failures[0].reason, reason); assert.deepEqual(failures[0].worker, predicate);
  });
  it('startup warming refusal -> startup-warming', async () => {
    only(await arm({ createFault: async () => { throw fail('TENANT_WARMING'); } }), 'startup-warming');
  });
  it('foreign tenant scope inside an admitted body -> scope-mismatch, never transient', async () => {
    const result = await arm({ fault: ({ window }) => window.assertCurrent(B) });
    only(result, 'scope-mismatch'); assert.equal(result.failures[0].innerGuard, 'scope-tenant-mismatch');
  });
  it('classifies an unavailable platform before output credit',async()=>{
    let available=true;
    const result=await arm({windowOptions:{available:()=>available},fault:({window})=>{
      available=false;
      try { window.assertCurrent(A); } finally { available=true; }
    }});
    only(result,'platform-unready');
  });
  it('an unrecognized refusal -> unknown', async () => {
    only(await arm({ fault: () => { throw fail('PRIVATE_UNCLASSIFIED_REFUSAL'); } }), 'unknown');
  });
  it('the oldest failure stays unresolved until the next credited completion, which records the interval', async () => {
    const result = await arm({ fault: ({ worker }) => { worker.generation = 9; } });
    assert.equal(result.first.unresolvedFailure, null); assert.equal(result.first.maxFailureResolutionMs, null);
    assert.equal(result.last.unresolvedFailure.reason, 'worker-generation'); assert(Number.isSafeInteger(result.last.unresolvedFailure.ageMs) && result.last.unresolvedFailure.ageMs >= 0);
    assert.equal(result.last.maxFailureResolutionMs, null);
    assert.equal(result.resolved.completedAcquisitions, result.last.completedAcquisitions + 1);
    assert.equal(result.resolved.unresolvedFailure, null, 'CREDIT_RESOLVES_FAILURE');
    assert(Number.isSafeInteger(result.resolved.maxFailureResolutionMs) && result.resolved.maxFailureResolutionMs >= 0);
  });
  it('the private v3 wire declares the vocabulary and carries the typed fields through the closed schema', async () => {
    const os = require('node:os'), path = require('node:path');
    const transport = require('../lib/server/internal-api/transport'), service = require('../lib/server/internal-api/contracts').evaluatorInspection;
    const inspection = require('../lib/server/serve/evaluator-inspection');
    const typed = { failureReasons: { ...reasons.empty(), 'startup-warming': 1 }, unresolvedFailure: { reason: 'startup-warming', ageMs: 5 }, maxFailureResolutionMs: null };
    async function wire (extra) {
      const row = tenant => ({ tenant, jobs: { running: false, booting: false, acquire: false, time: false, parentAcquire: false, parentTime: false }, dueAt: null, dueReason: null, ready: true, code: null, cycles: 1, outputRevision: 1, inputCheckpoint: 0, evaluatedAgeMs: 1, alert: null,
        progress: { generation: 1, completedAcquisitions: 1, completedTimeCycles: 0, failedCompletions: 1, lastCompletedAgeMs: 1, ...extra } });
      const inspect = inspection({ tenants: new Map([[A, true]]), gate: { inspect: async () => ({ configured: { mode: 'standalone', ordinal: 0, rule: null, leaseMs: null, configuredTenants: 1 }, observed: null,
        gate: { eligible: true, reason: null, members: null, reads: 0, refusals: 0, changes: 0, checkedAgeMs: null, heartbeats: null }, owner: () => null, admits: () => true }) },
      runtime: { health: selected => ({ runtimeId: A, tenants: selected.map(row) }) }, consumers: { health: selected => ({ tenants: selected.map(tenant => ({ tenant, state: 'idle', code: null, passes: 1, repeatAt: null })) }) } });
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'failure-reasons-')), endpoint = { socketPath: path.join(dir, 'inspect.sock'), maxBytes: 1048576, timeoutMs: 1000 };
      let listener;
      try { listener = await transport.compose(endpoint, [{ service, create: () => ({ inspectEvaluator: async (ctx, body) => inspect(body) }) }]); return await transport.client(endpoint, service).inspectEvaluator({ tenants: [A] }); }
      finally { await listener?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
    }
    const dto = await wire(typed);
    assert.equal(dto.failureReasonContract, 'evaluator-failure-reasons-v1');
    assert.deepEqual(dto.tenants[0].progress.failureReasons, typed.failureReasons);
    assert.deepEqual(dto.tenants[0].progress.unresolvedFailure, typed.unresolvedFailure); assert.equal(dto.tenants[0].progress.maxFailureResolutionMs, null);
    const old = await wire({});
    assert.equal(Object.hasOwn(old, 'failureReasonContract'), false, 'UNTYPED_PAGE_MUST_NOT_DECLARE');
    await assert.rejects(wire({ ...typed, failureReasons: { ...typed.failureReasons, 'schema-transition': 1 } }), /SOCKET_IPC_UNAVAILABLE/, 'CLOSED_REASON_SET_ON_WIRE');
  });
  it('reason counts always sum to failedCompletions', async () => {
    for (const fault of [() => { throw fail('TENANT_WARMING'); }, ({ worker }) => { worker.generation = 9; }]) {
      const { last } = await arm({ fault });
      assert.equal(Object.values(last.failureReasons).reduce((a, b) => a + b, 0), last.failedCompletions);
    }
  });
});

// Enter an admitted body, start a held operational verification, then let the
// body assert its own scope while verification is pending.
// Break-it controls: ablate one classifier branch in a compiled copy; the arm
// that depends on it goes red; the restored module passes.
function ablated (change) {
  const file = require.resolve('../lib/server/serve/evaluator-failure-reasons'), output = { exports: {} };
  vm.runInThisContext('(function(require,module,exports){' + change(fs.readFileSync(file, 'utf8')) + '\n})', { filename: file })(createRequire(file), output, output.exports);
  return output.exports;
}
describe('typed reason controls', function () {
  it('control: keeping a failure open after credit leaves it unresolved; restored runtime resolves it', async () => {
    const file = require.resolve('../lib/server/serve/evaluator-runtime'), text = fs.readFileSync(file, 'utf8'), needle = '      state.unresolvedFailure = null;\n';
    assert.equal(text.split(needle).length, 2);
    const output = { exports: {} };
    vm.runInThisContext('(function(require,module,exports,__filename,__dirname){' + text.replace(needle, '') + '\n})', { filename: file })(createRequire(file), output, output.exports, file, require('node:path').dirname(file));
    const criterion = async impl => { const r = await arm({ impl, fault: ({ worker }) => { worker.generation = 9; } }); assert.equal(r.resolved.unresolvedFailure, null, 'CREDIT_RESOLVES_FAILURE'); };
    await assert.rejects(criterion(output.exports), /CREDIT_RESOLVES_FAILURE/);
    await criterion(runtime);
  });
  it('control: dropping the scope-guard branch loses scope-mismatch; restored source keeps it', async () => {
    const needle = "    if (SCOPE_GUARDS.has(guard)) return 'scope-mismatch';\n";
    const broken = ablated(text => { assert.equal(text.split(needle).length, 2); return text.replace(needle, ''); });
    const f = fixture({ trustedWorker: true }); await f.window.ready();
    let error; await f.window.run(A, () => { try { f.window.assertCurrent(B); } catch (e) { error = e; } });
    try {
      assert.notEqual(broken.classify(error, { window: f.window, tenant: A }), 'scope-mismatch');
      assert.equal(reasons.classify(error, { window: f.window, tenant: A }), 'scope-mismatch');
    } finally { await f.window.close(); }
  });
  it('control: an untagged elevated-role refusal loses the authority type (unknown); restored readiness tag types authority', async () => {
    const readiness = require.resolve('../lib/tenant-lifecycle/operation-window-readiness');
    const text = fs.readFileSync(readiness, 'utf8'), needle = 'role[0].foreign_functions !== false) failAuthority();';
    assert.equal(text.split(needle).length, 2);
    const output = { exports: {} };
    vm.runInThisContext('(function(require,module,exports){' + text.replace(needle, 'role[0].foreign_functions !== false) fail();') + '\n})', { filename: readiness })(createRequire(readiness), output, output.exports);
    const errorFrom = async admitImpl => {
      const rows = [{ namespace_oid: 40, owner_oid: 39, uses_schema: true, elevated: true, owns_schema: false, database_create: false, elevated_membership: false, schema_writes: false, foreign_writes: false, foreign_functions: false }];
      try { await admitImpl({ query: async () => ({ rows }) }, 'ns', { lifetime: true }); } catch (error) { return error; }
      assert.fail('ELEVATED_ROLE_MUST_REFUSE');
    };
    const brokenError = await errorFrom(output.exports.admit), restoredError = await errorFrom(require(readiness).admit);
    assert.equal(brokenError.code, 'LIFECYCLE_WINDOW_SCHEMA_UNSAFE'); assert.equal(restoredError.code, 'LIFECYCLE_WINDOW_SCHEMA_UNSAFE', 'PUBLIC_CODE_UNCHANGED');
    assert.equal(reasons.classify(brokenError), 'unknown');
    assert.equal(reasons.classify(restoredError), 'authority');
  });
});
