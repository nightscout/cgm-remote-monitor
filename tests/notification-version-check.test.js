'use strict';
// covers: lib/tenant-notifications/producer.js, lib/server/serve/notification-version.js
// The producer's two "unchanged?" checks read only the version of the output
// (the runtime's observation), so a pass over an evicted output loads it once.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs'), vm = require('node:vm'), { createRequire } = require('node:module');
const startRuntime = require('../lib/server/serve/evaluator-runtime');
const producer = require('../lib/tenant-notifications/producer');
const notificationVersion = require('../lib/server/serve/notification-version');
const scope = require('../lib/storage/tenant-scope');
const lab = require('./fixtures/tenant-notifications');

const identity = 'a'.repeat(64);
const digest = revision => crypto.createHash('sha256').update('synthetic-output-' + revision).digest('hex');
function changed (file, needle, replacement) {
  const source = fs.readFileSync(file, 'utf8'), loaded = { exports: {} };
  assert.equal(source.split(needle).length, 2, 'CONTROL_NEEDLE_UNIQUE');
  vm.runInThisContext('(function(require,module,exports){' + source.replace(needle, replacement) + '\n})', { filename: file })(createRequire(file), loaded, loaded.exports);
  return loaded.exports;
}
const producerFile = require.resolve('../lib/tenant-notifications/producer');
const versionFile = require.resolve('../lib/server/serve/notification-version');

// A real evaluator runtime with a resident bound of 2 over 5 tenants, a durable
// store stand-in whose revision and digest advance on every completion, and a
// counted loadOutput (the cold output read).
async function fixture (f) {
  const tenants = [f.A, ...Array.from({ length: 4 }, (_, i) => String(i + 3).repeat(8) + '-' + String(i + 3).repeat(4) + '-4' + String(i + 3).repeat(3) + '-8' + String(i + 3).repeat(3) + '-' + String(i + 3).repeat(12))];
  const outputs = new Map(), counts = { loads: 0 };
  let revision = 0;
  const runtime = await startRuntime({ tenants, readCurrent: async tenant => ({ tenant, identity }),
    residentLimit: 2, checkConcurrency: 4,
    loadOutput: async tenant => { counts.loads++; return JSON.parse(JSON.stringify(outputs.get(tenant))); },
    externalRecovery: true, recoveryIntervalMs: 1000, timeIntervalMs: 1000, schedule () { throw Error('NO_ROSTER_INTERVAL'); }, cancel () {},
    setTimer: () => ({}), clearTimer () {}, now: () => 10000,
    durable: { begin: async () => ({ clock: '1' }), complete: async (tenant, { result }) => {
      revision++;
      const output = { tenant, identity, contentDigest: digest(revision), outputRevision: revision, inputCheckpoint: 1, result, rows: result.encodedRows, frame: result.frame };
      outputs.set(tenant, output); return { output, changed: true, pendingAt: null };
    } },
    create: async () => ({ async evaluate () {
      return { now: 10000, checkpoint: 1, properties: { bgnow: { mean: 123, mills: 9000 } }, requested: [], emitted: [], signature: { stamp: 1, deleted: 0 },
        encodedRows: [], frame: { sgvs: [] }, due: { dueAt: 20000, reason: 'expiry', slow: [] } };
    }, async evaluateTime () { throw Error('COLD_COMPONENT_MUST_ACQUIRE_ACCEPTED_STATE'); }, close () {} }) });
  return { runtime, tenants, outputs, counts };
}
const committedDigest = f => f.producerStates()[0].producer.output[1];

describe('notification producer version-only unchanged check', function () {
  let mode;
  beforeEach(() => { mode = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  afterEach(() => scope.setTenancyMode(mode));

  // Evict the tenant's full output, then run one pass and count cold loads.
  async function loadsPerPass (withVersion, make = producer) {
    const f = lab(), r = await fixture(f);
    try {
      for (const tenant of r.tenants) await r.runtime.acquire(tenant);
      assert.equal(r.runtime.last(f.A), null, 'OUTPUT_EVICTED_BEFORE_PASS');
      const current = tenant => r.runtime.output(tenant);
      const version = withVersion ? notificationVersion({ peek: tenant => r.runtime.peek(tenant), output: current }) : undefined;
      const p = make({ store: f.store, reader: { read: async () => [] }, current, ...(version ? { version } : {}),
        currentConfig: async () => ({ tenant: f.A, identity }), isCurrent: async () => true,
        consumer: 'realtime-test', now: () => Date.UTC(2026, 10, 21, 12), maxRows: 10, maxBytes: 65536, maxPayloadBytes: 10000 });
      try {
        const before = r.counts.loads, selected = await p.select(f.A);
        assert.equal(selected.consumedOutput.outputRevision, r.outputs.get(f.A).outputRevision);
        return r.counts.loads - before;
      } finally { p.close(); }
    } finally { await r.runtime.close(); }
  }
  it('a pass over an evicted output loads it once; the unchanged checks read only its version', async () => {
    assert.equal(await loadsPerPass(true), 1, 'ONE_OUTPUT_LOAD_PER_PASS');
  });
  it('control: without the version read a pass loads the evicted output three times', async () => {
    assert.equal(await loadsPerPass(false), 3, 'BASELINE_THREE_LOADS_PER_PASS');
  });

  // A newer output completes while the selection's transform runs.
  async function staleCriterion (make = producer) {
    const f = lab(), r = await fixture(f);
    try {
      for (const tenant of r.tenants) await r.runtime.acquire(tenant);
      assert.equal(r.runtime.last(f.A), null, 'OUTPUT_EVICTED_BEFORE_PASS');
      const first = r.outputs.get(f.A).outputRevision;
      let publish = true;
      const current = tenant => r.runtime.output(tenant);
      const p = make({ store: f.store, current,
        version: notificationVersion({ peek: tenant => r.runtime.peek(tenant), output: current }),
        reader: { async read () { if (publish) { publish = false; await r.runtime.acquire(f.A); } return []; } },
        currentConfig: async () => ({ tenant: f.A, identity }), isCurrent: async () => true,
        consumer: 'realtime-test', now: () => Date.UTC(2026, 10, 21, 12), maxRows: 10, maxBytes: 65536, maxPayloadBytes: 10000 });
      try {
        const selected = await p.select(f.A), newer = r.outputs.get(f.A);
        assert.equal(publish, false, 'NEWER_OUTPUT_PUBLISHED_DURING_SELECTION');
        assert(newer.outputRevision > first);
        assert.equal(selected.consumedOutput.outputRevision, newer.outputRevision, 'VERSION_CHECK_NOTICES_NEWER_OUTPUT');
        assert.equal(committedDigest(f), newer.contentDigest, 'VERSION_CHECK_NOTICES_NEWER_OUTPUT');
      } finally { p.close(); }
    } finally { await r.runtime.close(); }
  }
  it('notices a newer output published during the selection and selects against it', () => staleCriterion());
  it('control: an unchanged check that ignores the live version commits the older output, then restoration passes', async () => {
    const broken = changed(producerFile, 'const live = await version(tenant);', 'const live = observed;');
    await assert.rejects(staleCriterion(broken), /VERSION_CHECK_NOTICES_NEWER_OUTPUT/);
    await staleCriterion();
  });

  // Cold start: the runtime has not acquired the tenant (EVALUATOR_STARTING),
  // so it has no observation; the cold notification read is the durable row,
  // as evaluator-preview notificationOutput does.
  async function coldCriterion (makeVersion = notificationVersion, make = producer) {
    const f = lab(), r = await fixture(f);
    try {
      assert.equal(r.runtime.canReadColdOutput(f.A), true, 'RUNTIME_STILL_STARTING');
      assert.equal(r.runtime.peek(f.A), null, 'NO_OBSERVATION_AT_COLD_START');
      let stored = { tenant: f.A, identity, contentDigest: digest('cold-1'), outputRevision: 1, inputCheckpoint: 1, restoreGeneration: '1', result: { now: 10000, requested: [] } };
      let durableReads = 0, publish = true;
      const current = async tenant => {
        const local = await r.runtime.output(tenant);
        if (local || !r.runtime.canReadColdOutput(tenant)) return local;
        durableReads++; return { ...JSON.parse(JSON.stringify(stored)), runtimeId: r.runtime.runtimeId, eligible: true };
      };
      const p = make({ store: f.store, current, version: makeVersion({ peek: tenant => r.runtime.peek(tenant), output: current }),
        reader: { async read () { if (publish) { publish = false; stored = { ...stored, contentDigest: digest('cold-2'), outputRevision: 2 }; } return []; } },
        currentConfig: async () => ({ tenant: f.A, identity }), isCurrent: async () => true,
        consumer: 'realtime-test', now: () => Date.UTC(2026, 10, 21, 12), maxRows: 10, maxBytes: 65536, maxPayloadBytes: 10000 });
      try {
        const selected = await p.select(f.A);
        assert.equal(selected.consumedOutput.outputRevision, 2, 'COLD_START_NOTICES_NEWER_STORED_OUTPUT');
        assert.equal(committedDigest(f), digest('cold-2'), 'COLD_START_NOTICES_NEWER_STORED_OUTPUT');
        // Stale pass: selection read + transform check (refused); fresh pass: read + two checks.
        assert.equal(durableReads, 5, 'COLD_START_KEEPS_ITS_DURABLE_READ');
      } finally { p.close(); }
    } finally { await r.runtime.close(); }
  }
  it('cold start: selects from the durable output and notices a newer stored revision', () => coldCriterion());
  it('control: a version read that drops the cold-start path refuses every cold selection, then restoration passes', async () => {
    const broken = changed(versionFile, "return seen?.eligible === true ? seen : output(tenant);", 'return seen?.eligible === true ? seen : null;');
    await assert.rejects(coldCriterion(broken), /NOTIFICATION_PRODUCER_STALE/);
    await coldCriterion();
  });
  it('control: an unchanged check that ignores the live version misses the newer stored revision at cold start', async () => {
    const broken = changed(producerFile, 'const live = await version(tenant);', 'const live = observed;');
    await assert.rejects(coldCriterion(notificationVersion, broken), /COLD_START_NOTICES_NEWER_STORED_OUTPUT/);
  });
  it('refuses a version reader without peek and output', () => {
    assert.throws(() => notificationVersion({ output: async () => null }), /requires peek and output/);
  });
});
