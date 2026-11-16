'use strict';

// Actual runtime + trusted metadata/settings reader; supplied read-only SQL port.
// No feed, heartbeat, listener, database, provider or idle polling actor.
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const fs = require('node:fs');
const vm = require('node:vm');
const runtime = require('../lib/server/serve/evaluator-runtime');
const trusted = require('../lib/trusted-worker/postgres');
const config = require('../lib/server/serve/evaluator-config');
const activity = require('../lib/tenant-activity/eligibility');
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const ns = { activity: 'current_activity', clock: 'current_clock', settings: 'current_settings', operatorPolicy: 'current_policy' };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture (start = runtime) {
  const rows = new Map([A, B].map(tenant => [tenant, { version: 1, policy: 1, activity: '1', paused: false, suspended: false, seconds: false, pin: undefined }]));
  const scans = [], instances = new Map(); let configReads = 0, fail = false, held = null;
  const connection = { async readOnly (text, values) {
    if (/FROM pg_class/.test(text)) return { rows: Object.keys(ns).map(() => ({ secured: true, owns: false, writes: false })) };
    if (/WHERE false/.test(text)) return { rows: [] };
    if (/activity_version/.test(text)) {
      if (fail) throw Error('SYNTHETIC_METADATA_READ_FAILED');
      return { rows: values[0].map(tenant => { const row = rows.get(tenant); return { tenant, activity_version: row.activity, paused: row.paused, suspended: row.suspended,
        settings: row.version, policy: row.policy, stamp: '1', deleted: '0' }; }) };
    }
    const row = rows.get(values[0]);
    return { rows: [{ version: row.version, values: { SHOW_SECONDS: row.seconds }, generation: row.policy,
      policy: { deployment: {}, overrides: row.pin === undefined ? {} : { SHOW_SECONDS: { mode: 'pinned', pin: row.pin } } } }] };
  } };
  const reader = trusted.create({ connection, namespaces: ns, eventDriven: true, now: () => 100 });
  await reader.verify(); await reader.scan([A, B]);
  const readMetadata = async ids => { scans.push([...ids]); const result = await reader.scan(ids); if (held) { held.entered.resolve(); await held.release.promise; } return result; };
  Object.defineProperty(readMetadata, 'state', { value: reader.state });
  const bases = new Map([A, B].map(tenant => [tenant, config.registryEntry(tenant)]));
  const service = await start({ tenants: [A, B], readMetadata, metadataCurrent: reader.current, readSource: tenant => bases.get(tenant).identity,
    readCurrent: async tenant => { configReads++; return config.applySettings(bases.get(tenant), await reader.read(tenant)); },
    activity: activity.create({ read: async tenant => reader.current(tenant)?.activity }),
    create: async current => { const instance = { closed: false, reconfigurations: 0,
      async evaluate () { return { checkpoint: 1 }; }, async evaluateTime () { return { checkpoint: 1 }; },
      reconfigure () { this.reconfigurations++; }, close () { this.closed = true; } }; instances.set(current.tenant, instance); return instance; },
    externalRecovery: true, recoveryIntervalMs: 1000, timeIntervalMs: 60000,
    schedule: () => 1, cancel () {}, setTimer: () => 1, clearTimer () {}, now: () => 100 });
  return { service, reader, rows, scans, instances, configReads: () => configReads, fail: () => { fail = true; },
    hold: () => { held = { entered: deferred(), release: deferred() }; return held; },
    async close () { held?.release.resolve(); await service.close(); await reader.close(); } };
}

describe('pgstream current authority at output use', function () {
  it('reads authority once per use and reuses only exact runtime-owned settings versions', async function () {
    const f = await fixture();
    try {
      const before = f.configReads(), scans = f.scans.length, identity = f.service.last(A).identity;
      assert.equal(await f.service.isCurrent(A, identity), true);
      assert.deepEqual(f.scans.slice(scans), [[A]], 'ONE_TENANT_AUTHORITY_READ_PER_USE');
      assert.equal(f.configReads(), before, 'UNCHANGED_AUTHORITY_MUST_REUSE_RUNTIME_CONFIG');
      f.rows.get(A).policy++; f.rows.get(A).pin = true;
      assert.equal(await f.service.isCurrent(A, identity), false);
      assert.equal(f.configReads(), before + 1, 'CHANGED_AUTHORITY_MUST_READ_NEW_CONFIG');
    } finally { await f.close(); }
  });

  it('refuses silent committed settings or policy changes without a feed wake and preserves the neighbor', async function () {
    for (const kind of ['settings', 'policy']) {
      const f = await fixture();
      try {
        const before = f.service.last(A), neighbor = f.service.last(B), instance = f.instances.get(A), count = f.scans.length;
        if (kind === 'settings') { f.rows.get(A).version++; f.rows.get(A).seconds = true; }
        else { f.rows.get(A).policy++; f.rows.get(A).pin = true; }
        assert.equal(await f.service.isCurrent(A, before.identity), false, 'CURRENT_OUTPUT_MUST_REFRESH_COMMITTED_AUTHORITY');
        assert.deepEqual(f.scans.slice(count), [[A]], 'CURRENTNESS_READ_MUST_BE_TENANT_BOUNDED');
        assert.equal(f.service.last(A), null);
        assert.equal(instance.closed, false, 'SETTINGS_ONLY_CHANGE_RETAINS_CONTEXT_FOR_RECONFIGURATION');
        assert.deepEqual(f.service.last(B), neighbor);
        assert.equal(await f.service.isCurrent(B, neighbor.identity), true);
        await f.service.acquire(A);
        assert.equal(f.instances.get(A), instance);
        assert.equal(instance.reconfigurations, 1);
        assert.equal(await f.service.isCurrent(A, f.service.last(A).identity), true);
      } finally { await f.close(); }
    }
  });

  it('refreshes activity before eligibility checks so silent pause and suspension refuse output', async function () {
    for (const field of ['paused', 'suspended']) {
      const f = await fixture();
      try {
        const before = f.service.last(A), neighbor = f.service.last(B);
        f.rows.get(A)[field] = true; f.rows.get(A).activity = '2';
        assert.equal(await f.service.isCurrent(A, before.identity), false, 'CURRENT_OUTPUT_MUST_OBSERVE_SILENT_ACTIVITY_CHANGE');
        assert.equal(f.service.last(A), null);
        assert.deepEqual(f.service.last(B), neighbor);
        assert.equal(await f.service.isCurrent(B, neighbor.identity), true);
      } finally { await f.close(); }
    }
  });

  it('does not admit an obsolete result after worker generation changes across the metadata await', async function () {
    const f = await fixture();
    try {
      const before = f.service.last(A), held = f.hold(), pending = f.service.isCurrent(A, before.identity);
      await held.entered.promise;
      f.reader.invalidate(); await f.reader.verify(); await f.reader.scan([A]);
      held.release.resolve();
      assert.equal(await pending, false, 'CURRENTNESS_MUST_KEEP_WORKER_EPOCH_FENCE_AFTER_METADATA_AWAIT');
    } finally { await f.close(); }
  });

  it('retains the dispatch pause fence across the metadata await and resumes without an idle poll', async function () {
    const f = await fixture();
    try {
      const before = f.service.last(A), held = f.hold(), pending = f.service.isCurrent(A, before.identity);
      await held.entered.promise;
      const release = deferred(), entered = deferred();
      const verifying = f.service.verifyOperational(async () => { entered.resolve(); await release.promise; });
      await entered.promise; held.release.resolve();
      assert.equal(await pending, false);
      release.resolve(); await verifying;
      assert.equal(await f.service.isCurrent(A, before.identity), true);
    } finally { await f.close(); }
  });

  it('fails closed on an actual trusted metadata query refusal', async function () {
    const f = await fixture();
    try {
      const before = f.service.last(A); f.fail();
      assert.equal(await f.service.isCurrent(A, before.identity), false);
      assert.equal(f.reader.state().available, false);
      assert.equal(f.service.last(A), null);
    } finally { await f.close(); }
  });

  it('retains currentness behavior for a runtime without metadata capability', async function () {
    const identity = 'a'.repeat(64), service = await runtime({ tenants: [A], readCurrent: async () => ({ tenant: A, identity }),
      create: async () => ({ evaluate: async () => ({ checkpoint: 1 }), evaluateTime: async () => ({ checkpoint: 1 }), close () {} }),
      recoveryIntervalMs: 1000, timeIntervalMs: 60000, schedule: () => 1, cancel () {}, setTimer: () => 1, clearTimer () {} });
    try { assert.equal(await service.isCurrent(A, identity), true); } finally { await service.close(); }
  });

  it('control: rebuilding unchanged configuration adds a read; restored authority snapshot reuses it', async function () {
    const file = require.resolve('../lib/server/serve/evaluator-runtime'), source = fs.readFileSync(file, 'utf8');
    const needle = 'const current = unchanged ? state.current : await readCurrent(tenant);'; assert(source.includes(needle));
    const module = { exports: {} };
    vm.runInThisContext('(function(require,module,exports){' + source.replace(needle, 'const current = await readCurrent(tenant);') + '\n})', { filename: file })(createRequire(file), module, module.exports);
    async function criterion (start) {
      const f = await fixture(start);
      try { const before = f.configReads(); await f.service.isCurrent(A, f.service.last(A).identity);
        assert.equal(f.configReads(), before, 'UNCHANGED_CONFIG_MUST_NOT_BE_REBUILT_AT_USE');
      } finally { await f.close(); }
    }
    await assert.rejects(criterion(module.exports), /UNCHANGED_CONFIG_MUST_NOT_BE_REBUILT_AT_USE/);
    await criterion(runtime);
  });

  it('control: omitting the actual per-use refresh admits silent pause, then restored source refuses', async function () {
    const file = require.resolve('../lib/server/serve/evaluator-runtime'), source = fs.readFileSync(file, 'utf8');
    const needle = 'if (readMetadata) await readMetadata([tenant]);'; assert.equal(source.split(needle).length, 2);
    const broken = source.replace(needle, ''), module = { exports: {} };
    vm.runInThisContext('(function(require,module,exports){' + broken + '\n})', { filename: file })(createRequire(file), module, module.exports);
    async function criterion (start) {
      const f = await fixture(start);
      try { const before = f.service.last(A); f.rows.get(A).paused = true; f.rows.get(A).activity = '2';
        assert.equal(await f.service.isCurrent(A, before.identity), false, 'PER_USE_REFRESH_REQUIRED_FOR_CURRENT_AUTHORITY');
      } finally { await f.close(); }
    }
    await assert.rejects(criterion(module.exports), /PER_USE_REFRESH_REQUIRED_FOR_CURRENT_AUTHORITY/);
    await criterion(runtime);
  });
});
