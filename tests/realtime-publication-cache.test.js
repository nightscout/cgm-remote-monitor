'use strict';

// The evaluator registry boot seam reads current tenant settings per call and
// never a configuration file or a static roster. SQL adapters are doubled.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const A='11111111-1111-4111-8111-111111111111';
const nativeBoot = require('./fixtures/evaluator-native-recovery-protocol');

// Counts opens of `file`; a configuration read would open it.
function observe (file) {
  const open = fs.openSync, result = { reads: 0, fds: new Set() };
  fs.openSync = function (name, ...args) { if (name === file) result.reads++; return open.call(this, name, ...args); };
  result.restore = () => { fs.openSync = open; };
  return result;
}
// The maintained worker has no file-backed tenant settings or static roster.
function evaluatorConfig () {
  return { version: 1, postgres: { connectionEnv: 'EVAL_PG', namespaces: Object.fromEntries(
    ['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity', 'clock', 'checkpoint'].map(name => [name, 'hot_' + name])) },
    consumer: 'evaluator-hot', pageSize: 1, maxRows: 10, maxBytes: 10000, maxTenants: 2, timeIntervalMs: 200,
    registry: { namespace: 'hot_registry', refreshMs: 500 },
    tenantSettings: { connectionEnv: 'SETTINGS_PG', namespaces: { settings: 'hot_settings', operatorPolicy: 'hot_policy' } },
    activity: { connectionEnv: 'ACTIVITY_PG', namespace: 'hot_control' },
    trustedWorker: { activity: 'hot_control', clock: 'hot_clock', settings: 'hot_settings', operatorPolicy: 'hot_policy' },
    pgstream: { bounds: { stepMs: 5000, recoveryMs: 30000, pendingMs: 30000 } },
    writerDriven: { sweepMs: 5000, lifecycleNamespace: 'hot_control' } };
}
function isolatedModule (relative, overrides = {}, mutate = source => source) {
  const filename = require.resolve(relative), original = require('node:module').createRequire(filename), output = { exports: {} };
  require('node:vm').runInThisContext('(function(require,module,exports){' + mutate(fs.readFileSync(filename, 'utf8')) + '\n})', { filename })(
    id => Object.hasOwn(overrides, id) ? overrides[id] : original(id), output, output.exports);
  return output.exports;
}

describe('evaluator registry boot reads current settings, never a configuration file', function () {
  let dir, file;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-publication-cache-')); file = path.join(dir, 'config.json'); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  async function registryCurrent (mutate = source => source, inspect = () => {}) {
    const scope = require('../lib/storage/tenant-scope'), previous = scope.getTenancyMode();
    fs.writeFileSync(file, '{}'); const observed = observe(file);
    const nativeEvents=[],counts = { reads: 0, factories: 0, refreshes: 0, closes: 0, legacy: 0, finite: 0 }; let reached = false, assertionsReached = false;
    const settingsOf = isolatedModule('../lib/server/serve/evaluator-config', { '../../tenant-settings/effective-postgres': async () => {
      counts.finite++; throw new Error('finite settings fallback must not execute');
    } });
    const tenants = new Map([[A, settingsOf.registryEntry(A)]]); let enumerations = 0;
    const keys = tenants.keys.bind(tenants); let testingCurrent = false;
    tenants.keys = () => { if (testingCurrent) { enumerations++; throw new Error('registry roster read on current path'); } return keys(); };
    const boot = isolatedModule('../lib/server/serve/evaluator-preview', {
      ...nativeBoot.mocks({events:nativeEvents}),
      './evaluator-config': settingsOf,
      '../../storage/postgres-connection': async () => ({ end: async () => {} }),
      '../../storage/postgres-durable-replay':()=>nativeBoot.replay({events:nativeEvents}),
      '../../pool-membership': { member: async () => ({ register: async () => {}, close: async () => {}, configured: { leaseMs: 1000 } }) },
      './evaluator-pool': { create: () => ({ start () {}, refresh: async () => {}, close () {}, admits: () => true }) },
      '../../trusted-worker/postgres': { create: () => { counts.factories++; return { scan: async () => [],
        read: async tenant => { assert.equal(tenant, A); return { version: ++counts.reads, effective: {} }; }, close: async () => { counts.closes++; } }; } },
      '../../trusted-worker/lifecycle': async () => ({ close: async () => {} }),
      './role-readiness': require('./fixtures/role-readiness')(), './evaluator-readiness': async () => {},
      './registry-tenant-set': { openDemand: async () => ({ tenants, isActive: tenant => tenant === A, close: async () => {} }) },
      '../../writer-driven/evaluator': { open: async ({ config: current }) => {
        testingCurrent = true; reached = true; fs.unlinkSync(file); let prior;
        for (let i = 0; i < 200; i++) {
          const value = await current.readCurrent(A); assert.equal(value.revision, 'registry');
          if (prior) assert.notEqual(value.identity, prior, 'each call applies freshly read version'); prior = value.identity;
        }
        assert.equal(observed.reads, 0); assert.equal(enumerations, 0); assert.equal(counts.reads, 200); assertionsReached = true;
        throw new Error('end focused composition discriminator before clinical startup');
      } }
    }, mutate);
    // Actual boot must replace this poison callback; neither it nor finite
    // settings fallback can satisfy this owned-reader composition discriminator.
    const config = { ...evaluatorConfig(), pgstream:nativeBoot.config(evaluatorConfig().pgstream), namespaces: evaluatorConfig().postgres.namespaces, registry: { namespace: 'synthetic_registry' }, maxTenants: 10, tenants: new Map(), tenantSettings: {},
      readCurrent: async () => { counts.legacy++; throw new Error('legacy callback must not execute in registry mode'); } };
    try {
      await assert.rejects(boot.boot(config, { operationWindow: {} }), /readiness or initialization refused/);
      assert.equal(reached, true); assert.equal(counts.reads, 200); assert.equal(assertionsReached, true);
      assert.equal(observed.reads, 0); assert.equal(enumerations, 0);
      assert.deepEqual(counts, { reads: 200, factories: 1, refreshes: 0, closes: 1, legacy: 0, finite: 0 });
      assert.equal(nativeEvents.filter(value=>value==='schema-checked').length,1,'REGISTRY_FOCUSED_EXIT_AFTER_ONE_SCHEMA_CHECK');
    } finally {
      try { inspect({ ...counts, reached, assertionsReached }); }
      finally { observed.restore(); scope.setTenancyMode(previous); }
    }
  }

  it('EVALUATOR_REGISTRY_CURRENT: actual registry boot seam uses per-tenant settings with zero legacy file/roster reads', async function () {
    const scope = require('../lib/storage/tenant-scope'), previous = scope.getTenancyMode();
    await registryCurrent();
    assert.equal(scope.getTenancyMode(), previous, 'REGISTRY_BOOT_FIXTURE_RESTORES_TENANCY_MODE');
  });

  it('EVALUATOR_REGISTRY_CURRENT_CONTROLS: removing the owned reader or registry override is red, and restoration reaches every assertion', async function () {
    const owned = 'settingsOf.withSettings(base, entry, tenant, settingsReader)';
    const override = 'async readCurrent (tenant) {';
    const source = fs.readFileSync(require.resolve('../lib/server/serve/evaluator-preview'), 'utf8');
    for (const [needle, replacement, expected] of [
      [owned, 'settingsOf.withSettings(base, entry, tenant)', { finite: 1, legacy: 0 }],
      [override, 'async unusedRegistryReader (tenant) {', { finite: 0, legacy: 1 }]
    ]) {
      assert.equal(source.split(needle).length, 2, 'control must land on actual source'); let observed;
      await assert.rejects(registryCurrent(value => value.replace(needle, replacement), value => { observed = value; }),
        error => error.code === 'ERR_ASSERTION' && error.actual === 0 && error.expected === 200);
      assert.equal(observed.reached, true); assert.equal(observed.assertionsReached, false);
      assert.equal(observed.finite, expected.finite); assert.equal(observed.legacy, expected.legacy);
      await registryCurrent();
    }
  });

});
