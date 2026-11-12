'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const scope = require('../lib/storage/tenant-scope');
const evaluator = require('../lib/server/serve/evaluator-config');
const A = '00000000-0000-0000-0000-000000000001', B = '00000000-0000-0000-0000-000000000002';
const configuration = { connectionString: 'synthetic', namespaces: { settings: 'synthetic_settings', operatorPolicy: 'synthetic_policy' } };
function isolated (file, mocks, mutate = source => source) {
  const filename = path.resolve(__dirname, '../lib/' + file), loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = loaded.require.bind(loaded);
  loaded.require = name => Object.hasOwn(mocks, name) ? mocks[name] : original(name);
  loaded._compile(mutate(fs.readFileSync(filename, 'utf8')), filename); return loaded.exports;
}
function fixture ({ skipRefresh = false, skipDrain = false } = {}) {
  const calls = { factory: 0, readiness: 0, catalogue: 0, pool: 0, screen: 0, read: 0, close: 0 };
  const state = { unsafe: false, readinessFails: false, catalogueFails: false, queryFails: false, hold: null };
  const rows = new Map([[A, { version: 1, values: { SHOW_SECONDS: true }, generation: 1, policy: { deployment: {}, overrides: {} } }],
    [B, { version: 1, values: { SHOW_SECONDS: false }, generation: 1, policy: { deployment: {}, overrides: {} } }]]);
  const factory = isolated('tenant-settings/effective-postgres.js', {
    './readiness': async () => { calls.readiness++; if (state.hold) await state.hold; if (state.readinessFails) throw Error('synthetic readiness'); },
    '../migrations/postgres': { run: async () => { calls.catalogue++; if (state.catalogueFails) throw Error('synthetic catalogue'); } },
    '../storage/postgres-connection': async () => { calls.pool++; return {
      withTenant: (tenant, fn) => scope.withTenant(tenant, fn),
      async query (sql, args) {
        if (sql.includes('pg_class')) { calls.screen++; return { rows: [0, 1].map(() => ({ secured: !state.unsafe, owns: false, reads: true, writes: false })) }; }
        calls.read++; assert.equal(scope.currentTenant(), args[0]);
        if (state.queryFails) throw Error('synthetic query');
        return { rows: rows.has(args[0]) ? [structuredClone(rows.get(args[0]))] : [] };
      }, async end () { calls.close++; }
    }; }
  });
  const open = async options => { calls.factory++; return factory(options); };
  const presentation = isolated('tenant-settings/presentation-reader.js', { './effective-postgres': open }, source => {
    if (skipRefresh) source = source.replace('await resource.refresh();', 'void 0;');
    if (skipDrain) source = source.replace('await Promise.allSettled([...reads]);', '');
    return source;
  });
  const reader = { ...presentation(configuration, { revalidate: true, preserveErrors: true }), matches: current => require('node:util').isDeepStrictEqual(current, configuration) };
  const finite = isolated('server/serve/evaluator-config.js', { '../../tenant-settings/effective-postgres': open });
  return { calls, state, rows, reader, async readFinite (tenant) { return finite.withSettings({ tenantSettings: configuration }, finite.registryEntry(tenant), tenant); }, async read (tenant) { return evaluator.withSettings({ tenantSettings: configuration }, evaluator.registryEntry(tenant), tenant, reader); } };
}

describe('evaluator retained settings capability', function () {
  let previous;
  beforeEach(() => { previous = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  afterEach(() => scope.setTenancyMode(previous));
  it('reuses one max4 pool while screening and reading fresh owner and policy state for each tenant', async function () {
    const f = fixture();
    try {
      const first = await f.read(A); assert.equal(first.env.settings.units, 'mg/dl'); assert.equal(first.env.settings.showSeconds, true);
      f.rows.get(A).version++; f.rows.get(A).values.SHOW_SECONDS = false;
      const owner = await f.read(A); assert.notEqual(owner.identity, first.identity); assert.equal(owner.env.settings.showSeconds, false);
      f.rows.get(A).generation++; f.rows.get(A).policy.overrides.DISPLAY_UNITS = { mode: 'pinned', pin: 'mmol' };
      assert.equal((await f.read(A)).env.settings.units, 'mmol');
      assert.equal((await f.read(B)).env.settings.units, 'mg/dl');
      assert.deepEqual(f.calls, { factory: 1, readiness: 4, catalogue: 8, pool: 1, screen: 4, read: 4, close: 0 });
    } finally { await f.reader.close(); }
    assert.equal(f.calls.close, 1); await f.reader.close(); await assert.rejects(f.read(A), { code: 'SETTINGS_POLICY_UNAVAILABLE' }); assert.equal(f.calls.pool, 1);
  });
  it('makes the prior finite lifecycle red on pool construction count, with identical per-read screening', async function () {
    for (const finite of [true, false]) {
      const f = fixture(); try {
        for (const tenant of [A, B, A]) await (finite ? f.readFinite(tenant) : f.read(tenant));
        assert.equal(f.calls.readiness, 3); assert.equal(f.calls.catalogue, 6); assert.equal(f.calls.screen, 3); assert.equal(f.calls.read, 3);
        if (finite) { assert.equal(f.calls.pool, 3); assert.throws(() => assert.equal(f.calls.pool, 1), { code: 'ERR_ASSERTION' }); }
        else assert.equal(f.calls.pool, 1);
      } finally { await f.reader.close(); }
      assert.equal(f.calls.close, finite ? 3 : 1);
    }
  });
  it('retains per-read unsafe-object, readiness, catalogue, missing policy and transport refusal; recovers with a new capability', async function () {
    for (const [key, pattern] of [['unsafe', /SETTINGS_STORE_UNSAFE/], ['readinessFails', /synthetic readiness/], ['catalogueFails', /synthetic catalogue/], ['queryFails', /SETTINGS_POLICY_UNAVAILABLE/]]) {
      const f = fixture(); try {
        await f.read(A); f.state[key] = true; await assert.rejects(f.read(A), pattern); assert.equal(f.calls.close, 1);
        f.state[key] = false; await f.read(B); assert.equal(f.calls.pool, 2);
        f.rows.delete(A); await assert.rejects(f.read(A), { code: 'SETTINGS_POLICY_UNAVAILABLE' });
      } finally { await f.reader.close(); }
    }
  });
  it('requires restart when the resolved hotfile credential or namespace binding changes', async function () {
    const f = fixture(); try {
      await f.read(A);
      for (const changed of [{ ...configuration, connectionString: 'synthetic-rotated' }, { ...configuration, namespaces: { settings: 'other', operatorPolicy: 'synthetic_policy' } }]) {
        await assert.rejects(evaluator.withSettings({ tenantSettings: changed }, evaluator.registryEntry(A), A, f.reader), /require restart/);
      }
      assert.equal(f.calls.read, 1);
    } finally { await f.reader.close(); }
  });
  it('detects removed refresh against the changed authority guard and restores green', async function () {
    async function observe (skipRefresh) {
      const f = fixture({ skipRefresh }); try { await f.read(A); f.state.unsafe = true; await assert.rejects(f.read(A), /SETTINGS_STORE_UNSAFE/); } finally { await f.reader.close(); }
    }
    await assert.rejects(observe(true), { code: 'ERR_ASSERTION' }); await observe(false);
  });
  it('drains in-flight revalidation before close, and removing the drain is red', async function () {
    async function observe (skipDrain) {
      const f = fixture({ skipDrain }); await f.read(A); let release;
      f.state.hold = new Promise(resolve => { release = resolve; });
      const reading = assert.rejects(f.read(A), { code: 'SETTINGS_POLICY_UNAVAILABLE' });
      await new Promise(resolve => setImmediate(resolve));
      let stopped = false; const closing = f.reader.close().then(() => { stopped = true; });
      await new Promise(resolve => setImmediate(resolve)); const premature = stopped;
      release(); await reading; await closing; assert.equal(f.calls.close, 1);
      return premature;
    }
    assert.equal(await observe(true), true, 'mutant returns before its direct readiness check drains');
    assert.equal(await observe(false), false, 'restored shutdown waits');
  });
});

describe('evaluator settings pool ownership at actual role boot', function () {
  it('covers legacy and registry reads, startup failure, idempotent close and cleanup after reader close failure', async function () {
    const previous = scope.getTenancyMode();
    try {
      for (const registry of [false, true]) for (const outcome of ['normal', 'startup-failure', 'close-failure', 'both-close-fail']) {
        const calls = { settingsClose: 0, clinicalClose: 0, settingsRead: 0, runtimeClose: 0 }; let prepared, active = true;
        const settings = { read: async tenant => { calls.settingsRead++; assert.equal(tenant, A); return { version: 1, effective: {} }; }, close: async () => { calls.settingsClose++; if (outcome.includes('close-fail')) throw Error('synthetic close failure'); } };
        const runtime = { acquire: async () => {}, tick: async () => {}, health: () => ({}), last: () => null, isCurrent: async () => true, close: async () => { calls.runtimeClose++; if (outcome === 'both-close-fail') throw Error('synthetic runtime close failure'); } };
        const boot = isolated('server/serve/evaluator-preview.js', {
          '../../tenant-settings/presentation-reader': (input, options) => { assert.deepEqual(input, configuration); assert.deepEqual(options, { revalidate: true, preserveErrors: true }); return settings; },
          '../../storage/postgres-connection': async () => ({ end: async () => { calls.clinicalClose++; } }),
          './evaluator-readiness': Object.assign(async () => {}, { provisionTenant: async () => {} }),
          './evaluator-consumers': { prepare: async () => null },
          './registry-tenant-set': { open: async () => ({ tenants: new Map([[A, evaluator.registryEntry(A)]]), isActive: () => active, revision: () => 1, stats: () => ({}), close: async () => {}, follow: async handlers => { prepared = handlers; } }) },
          './evaluator-runtime': async config => { assert.equal((await config.readCurrent(A)).env.settings.units, 'mg/dl'); if (registry) { active = false; assert.equal(await config.readCurrent(A), null); active = true; assert.equal((await config.readCurrent(A)).env.settings.units, 'mg/dl'); } if (outcome === 'startup-failure') throw Error('synthetic startup'); return runtime; }
        });
        const config = { tenantSettings: configuration, tenants: new Map([[A, evaluator.registryEntry(A)]]),
          namespaces: Object.fromEntries(['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity', 'clock', 'checkpoint'].map(name => [name, 'synthetic_' + name])),
          ...(registry ? { registry: {} } : {}), readCurrent: (tenant, reader) => evaluator.withSettings({ tenantSettings: configuration }, evaluator.registryEntry(tenant), tenant, reader) };
        if (outcome === 'startup-failure') { await assert.rejects(boot.boot(config), /initialization refused/); }
        else {
          const role = await boot.boot(config); assert.equal(calls.settingsRead, registry ? 2 : 1);
          if (registry) assert.equal(typeof prepared.prepare, 'function');
          if (outcome.includes('close-fail')) { await assert.rejects(role.close(), error => error.errors.length === (outcome === 'both-close-fail' ? 2 : 1) && error.errors.some(cause => /synthetic close failure/.test(cause.message))); await assert.rejects(role.close(), /shutdown refused/); }
          else { await role.close(); await role.close(); }
        }
        assert.equal(calls.settingsClose, 1); assert.equal(calls.clinicalClose, 1); assert.equal(calls.runtimeClose, outcome === 'startup-failure' ? 0 : 1);
      }
    } finally { scope.setTenancyMode(previous); }
  });
});
