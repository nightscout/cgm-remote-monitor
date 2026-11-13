'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const scope = require('../lib/storage/tenant-scope');
const { createTenantSettings, resolveEffectiveSettings } = require('../lib/tenant-settings/component');
const { validateCatalogue } = require('../lib/migrations/catalogue');
const A = '11111111-1111-4111-8111-111111111111';
const actor = { tenant: A, principal: 'owner', consumer: 'management' };
const policy = { deployment: {}, overrides: {}, generation: 1 };

function load (relative, connection, mutation) {
  const filename = path.resolve(__dirname, '..', relative);
  const loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = loaded.require.bind(loaded);
  loaded.require = request => request === '../storage/postgres-connection' ? async () => connection : originalRequire(request);
  const source = fs.readFileSync(filename, 'utf8');
  loaded._compile(mutation ? mutation(source) : source, filename);
  return loaded.exports;
}
function fixture () {
  const state = { authority: { active: true, can_configure: true }, generation: 1,
    current: { version: 1, values: { DISPLAY_UNITS: 'mg/dl' } }, history: [], order: [], closed: 0,
    authorityPrivileges: { secured: true, owns: false, reads: true, mutates: false, update_columns: ['owner_fence'] },
    policyPrivileges: { secured: true, owns: false, reads: true, writes: false } };
  const connection = {
    async withTenant (tenant, fn) {
      assert.equal(typeof tenant, 'string');
      const before = structuredClone({ current: state.current, history: state.history });
      try { return await fn(); }
      catch (error) { state.current = before.current; state.history = before.history; throw error; }
    },
    async query (sql, params) {
      if (sql.includes('AS current_state')) return { rows: [
        { secured: true, owns: false, mutates: false, current_state: true, reads: true, inserts: true, updates: true, column_reads: true, column_updates: true },
        { secured: true, owns: false, mutates: false, history: true, reads: true, inserts: true, updates: false, column_reads: true, column_updates: false },
        { secured: true, owns: false, mutates: false, policy: true, reads: true, inserts: false, updates: false, column_reads: true, column_updates: false }
      ] };
      if (sql.includes('AS update_columns')) return { rows: [state.authorityPrivileges] };
      if (sql.includes('AS writes')) return { rows: [state.policyPrivileges] };
      if (sql.startsWith('SET LOCAL')) return { rows: [] };
      if (sql.startsWith('SELECT active')) {
        assert.deepEqual(params, [A, actor.principal, actor.consumer]);
        state.order.push(sql.endsWith('FOR SHARE') ? 'actor-lock' : 'actor-read');
        return { rows: state.authority ? [structuredClone(state.authority)] : [] };
      }
      if (sql.includes('pg_advisory_xact_lock')) { state.order.push('policy-lock'); return { rows: [] }; }
      if (sql.startsWith('SELECT generation, policy')) return { rows: state.missingPolicy ? [] : [
        { generation: state.generation, policy: state.policy || { deployment: {}, overrides: {} } }
      ] };
      if (sql.startsWith('SELECT generation')) return { rows: [{ generation: state.generation }] };
      if (sql.startsWith('UPDATE "settings".tenant_settings')) {
        state.order.push('state-write');
        if (state.current.version !== params[1]) return { rows: [] };
        state.current = { version: state.current.version + 1, values: JSON.parse(params[2]) };
        return { rows: [structuredClone(state.current)] };
      }
      if (sql.startsWith('INSERT INTO "settings".tenant_settings_history')) {
        state.order.push('history-write');
        if (state.failHistory) throw new Error('synthetic history failure');
        state.history.push({ version: params[1], values: JSON.parse(params[2]) }); return { rows: [] };
      }
      throw new Error('Unexpected source fixture SQL');
    },
    async end () { state.closed++; }
  };
  return { state, connection };
}
async function settingsStore (f, mutation, selected = true) {
  return load('lib/tenant-settings/postgres.js', f.connection, mutation)({ connectionString: 'synthetic-connection',
    namespace: 'settings', policyNamespace: 'policy', ...(selected ? { configurationAuthorityNamespace: 'configuration' } : {}) });
}
async function race (mutation, change) {
  const f = fixture(), store = await settingsStore(f, mutation);
  const service = createTenantSettings({ store,
    authorize: async who => { const authority = await store.currentConfigurationAuthority(who); return authority?.active && authority?.canConfigure; },
    policyFor: async () => { change(f.state); return policy; } });
  return { f, write: () => service.replace(actor, 1, { SHOW_SECONDS: true }) };
}

describe('owner configuration persistence source boundaries', function () {
  let previous;
  before(() => { previous = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  after(() => scope.setTenancyMode(previous));
  it('new immutable catalogue defaults capability false and forces tenant RLS', function () {
    const candidate = require('../lib/tenant-settings/owner-authority-candidate.json');
    assert.equal(validateCatalogue(candidate).length, 1);
    const sql = candidate.migrations[0].up.join('\n');
    assert.match(sql, /active boolean NOT NULL DEFAULT false/); assert.match(sql, /can_configure boolean NOT NULL DEFAULT false/);
    assert.match(sql, /FORCE ROW LEVEL SECURITY/); assert.match(sql, /WITH CHECK/); assert.match(sql, /REVOKE ALL/);
  });
  it('keeps unselected legacy settings persistence independent of capability table', async function () {
    const f = fixture(), store = await settingsStore(f, null, false);
    assert.equal(store.currentConfigurationAuthority, undefined);
    await store.write(actor, 1, {}, 'replace', undefined, 1);
    assert.ok(!f.state.order.some(value => value.startsWith('actor-')));
  });
  it('current capability is exact actor bound and absence does not inherit other grants', async function () {
    const f = fixture(), store = await settingsStore(f);
    assert.deepEqual(await store.currentConfigurationAuthority(actor), { active: true, canConfigure: true });
    f.state.authority = { active: true, can_configure: false, can_update: true, permissions: ['*'] };
    assert.deepEqual(await store.currentConfigurationAuthority(actor), { active: true, canConfigure: false });
    f.state.authority = undefined; assert.equal(await store.currentConfigurationAuthority(actor), undefined);
  });
  it('requires sentinel-only UPDATE and refuses logical capability mutation grants', async function () {
    for (const change of [row => { row.update_columns.push('can_configure'); }, row => { row.mutates = true; },
      row => { row.secured = false; }, row => { row.owns = true; }]) {
      const f = fixture(); change(f.state.authorityPrivileges);
      await assert.rejects(settingsStore(f), { code: 'SETTINGS_STORE_UNSAFE' }); assert.equal(f.state.closed, 1);
    }
  });
  it('fences committed configure revocation after initial authorization before state/history', async function () {
    const { f, write } = await race(null, state => { state.authority.can_configure = false; });
    await assert.rejects(write(), { code: 'SETTINGS_FORBIDDEN' });
    assert.equal(f.state.current.version, 1); assert.equal(f.state.history.length, 0);
    assert.deepEqual(f.state.order, ['actor-read', 'actor-lock']);
  });
  it('write-fence ablation actually mutates state/history and falsifies the refusal oracle', async function () {
    const needle = 'const authority = await configurationAuthority(actor, true);';
    const { f, write } = await race(source => {
      assert.equal(source.split(needle).length, 2); return source.replace(needle, 'const authority = { active: true, canConfigure: true };');
    }, state => { state.authority.can_configure = false; });
    await assert.rejects(async () => assert.rejects(write(), { code: 'SETTINGS_FORBIDDEN' }), { code: 'ERR_ASSERTION' });
    assert.equal(f.state.current.version, 2); assert.equal(f.state.history.length, 1);
    const restored = await race(null, state => { state.authority.can_configure = false; });
    await assert.rejects(restored.write(), { code: 'SETTINGS_FORBIDDEN' });
    assert.equal(restored.f.state.current.version, 1);
  });
  it('locks configuration actor before operator policy and commits history after current state', async function () {
    const f = fixture(), store = await settingsStore(f);
    await store.write(actor, 1, { SHOW_SECONDS: true }, 'replace', undefined, 1);
    assert.deepEqual(f.state.order, ['actor-lock', 'policy-lock', 'state-write', 'history-write']);
  });
  it('policy-generation race refuses independently and omission control proves a real write', async function () {
    const normal = await race(null, state => { state.generation = 2; });
    await assert.rejects(normal.write(), { code: 'POLICY_GENERATION_CONFLICT' });
    assert.equal(normal.f.state.current.version, 1); assert.equal(normal.f.state.history.length, 0);
    const needle = 'await fence(actor.tenant, policyGeneration);';
    const broken = await race(source => {
      assert.equal(source.split(needle).length, 2); return source.replace(needle, '/* deliberate source-only policy fence omission */');
    }, state => { state.generation = 2; });
    await assert.rejects(async () => assert.rejects(broken.write(), { code: 'POLICY_GENERATION_CONFLICT' }), { code: 'ERR_ASSERTION' });
    assert.equal(broken.f.state.current.version, 2); assert.equal(broken.f.state.history.length, 1);
  });
  it('history append failure rolls back current state after both fences', async function () {
    const f = fixture(), store = await settingsStore(f); f.state.failHistory = true;
    await assert.rejects(store.write(actor, 1, {}, 'replace', undefined, 1), { code: 'SETTINGS_STORE_UNAVAILABLE' });
    assert.equal(f.state.current.version, 1); assert.equal(f.state.history.length, 0);
  });
  it('policy read factory has no writer and refuses privilege escalation', async function () {
    const f = fixture(), create = load('lib/operator-policy/postgres-read.js', f.connection);
    const reader = await create({ connectionString: 'synthetic-connection', namespace: 'policy' });
    assert.equal(reader.write, undefined); assert.deepEqual(await reader.read(A), { generation: 1, policy: { deployment: {}, overrides: {} } });
    f.state.policyPrivileges.writes = true;
    await assert.rejects(create({ connectionString: 'synthetic-connection', namespace: 'policy' }), { code: 'SETTINGS_POLICY_UNSAFE' });
  });
  it('policy reader never converts missing or malformed policy to open defaults', async function () {
    const f = fixture(), reader = await load('lib/operator-policy/postgres-read.js', f.connection)({ connectionString: 'synthetic-connection', namespace: 'policy' });
    for (const invalid of [{ deployment: {}, overrides: { TIMEZONE: { mode: 'open' } } }, { deployment: {}, overrides: { SHOW_SECONDS: { mode: 'pinned', pin: 'true' } } }]) {
      f.state.policy = invalid; await assert.rejects(reader.read(A), { code: 'SETTINGS_POLICY_UNAVAILABLE' });
    }
    f.state.missingPolicy = true; await assert.rejects(reader.read(A), { code: 'SETTINGS_POLICY_UNAVAILABLE' });
  });
  it('shared resolver preserves precedence/provenance without mutating snapshots', function () {
    const state = { version: 3, values: { DISPLAY_UNITS: 'mmol', SHOW_SECONDS: true } };
    const selectedPolicy = { generation: 2, deployment: {}, overrides: { DISPLAY_UNITS: { mode: 'pinned', pin: 'mg/dl' } } };
    const result = resolveEffectiveSettings(state, selectedPolicy);
    assert.equal(result.effective.DISPLAY_UNITS.value, 'mg/dl'); assert.equal(result.effective.DISPLAY_UNITS.ignoredReason, 'pinned');
    assert.equal(result.effective.SHOW_SECONDS.value, true); assert.equal(state.values.DISPLAY_UNITS, 'mmol');
    assert.throws(() => resolveEffectiveSettings(state, { deployment: {}, overrides: {} }), { code: 'SETTINGS_POLICY_UNAVAILABLE' });
  });
});

describe('projected owner catalogue and next-cycle source consumers', function () {
  const catalogue = require('../lib/tenant-settings/catalogue');
  const environment = require('../lib/server/tenant-app/environment');
  const presentation = require('../lib/server/tenant-app/presentation-environment');
  const evaluatorConfig = require('../lib/server/serve/evaluator-config');
  const runtimeFactory = require('../lib/server/serve/evaluator-runtime');
  const evaluatorFactory = require('../lib/data/tenant-projection-evaluator');
  const B = '22222222-2222-4222-8222-222222222222';
  const thresholds = { bgHigh: 260, bgTargetTop: 200, bgTargetBottom: 80, bgLow: 55 };
  function memory () {
    const records = new Map([[A, { version: 1, values: {} }], [B, { version: 1, values: {} }]]);
    const history = new Map(); let allowed = true;
    const store = { async read (tenant) { return structuredClone(records.get(tenant)); },
      async history (tenant, version) { return structuredClone(history.get(tenant + ':' + version)); },
      async write (who, expected, values) {
        const previous = records.get(who.tenant);
        if (previous.version !== expected) return undefined;
        const next = { version: previous.version + 1, values: structuredClone(values) };
        records.set(who.tenant, next); history.set(who.tenant + ':' + next.version, structuredClone(next));
        return structuredClone(next);
      } };
    let currentPolicy = structuredClone(policy);
    return { records, history, store, service: createTenantSettings({ store, policyFor: async () => structuredClone(currentPolicy),
      authorize: async () => allowed }), revoke () { allowed = false; }, policy (value) { currentPolicy = value; } };
  }
  function loadMutation (relative, needle, replacement) {
    const filename = path.resolve(__dirname, '..', relative), source = fs.readFileSync(filename, 'utf8');
    assert.equal(source.split(needle).length, 2, 'control targets exactly one source mechanism');
    const loaded = new Module(filename, module); loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
    loaded._compile(source.replace(needle, replacement), filename); return loaded.exports;
  }
  it('covers exactly actual projected keys, enable and thresholds; aliases stay compatible and unsupported names refuse', async function () {
    const expected = environment.CLIENT_KEYS.map(name => name === 'units' ? 'DISPLAY_UNITS' : name === 'showSeconds' ? 'SHOW_SECONDS' : name)
      .concat('enable', environment.THRESHOLDS).sort();
    assert.deepEqual(Object.keys(catalogue.DEFAULTS).sort(), expected);
    const f = memory();
    const written = await f.service.replace(actor, 1, { units: 'mmol', showSeconds: true, theme: 'colors', enable: ['bgnow'], thresholds });
    assert.equal(written.values.DISPLAY_UNITS, 'mmol'); assert.equal(written.values.SHOW_SECONDS, true);
    assert.equal(written.values.bgHigh, 260); assert.equal(written.values.thresholds, undefined);
    for (const input of [{ API_SECRET: 'synthetic' }, { DEBUG_LOGGING: true }, { IMPORT_CONFIG: 'synthetic' }, { integrations: [] },
      { units: 'invalid' }, { showSeconds: 'true' }, { alarmHigh: 'true' }, { alarmHighMins: ['15'] }, { enable: ['BAD'] },
      { bgHigh: 200 }, { thresholds: { bgHigh: 200 } }, { ...thresholds, bgLow: 29 }, { ...thresholds, bgHigh: 601 },
      { DISPLAY_UNITS: 'mg/dl', units: 'mmol' }]) {
      await assert.rejects(f.service.replace(actor, 2, input), error => ['SETTINGS_VALUE', 'SETTINGS_UNSUPPORTED'].includes(error.code));
      assert.equal(f.records.get(A).version, 2); assert.equal(f.history.size, 1);
    }
    assert.deepEqual(f.records.get(B), { version: 1, values: {} });
  });
  it('preserves typed array bounds, operator defaults/pins, independent snapshots and whole rollback refusal', async function () {
    const f = memory();
    await f.service.replace(actor, 1, { alarmHighMins: [10, 20], ...thresholds });
    f.policy({ generation: 2, deployment: { alarmHighMins: { mode: 'bounded', allowed: [[10, 20], [30]], default: [30] },
      bgHigh: { mode: 'open', default: 280 } }, overrides: {} });
    const good = await f.service.replace(actor, 2, { alarmHighMins: [10, 20], ...thresholds });
    assert.deepEqual(good.effective.alarmHighMins.value, [10, 20]); good.effective.alarmHighMins.value.push(999);
    assert.deepEqual((await f.service.read(actor)).effective.alarmHighMins.value, [10, 20]);
    f.policy({ generation: 3, deployment: { alarmHighMins: { mode: 'pinned', pin: [30] } }, overrides: {} });
    await assert.rejects(f.service.rollback(actor, 3, 2), { code: 'SETTINGS_POLICY_REFUSED' });
    assert.equal(f.records.get(A).version, 3); assert.equal(f.history.size, 2);
    const current = await f.service.read(actor); assert.deepEqual(current.effective.alarmHighMins.value, [30]);
    assert.deepEqual(current.effective.alarmHighMins.storedOwnerValue, [10, 20]);
    f.revoke(); await assert.rejects(f.service.replace(actor, 3, {}), { code: 'SETTINGS_FORBIDDEN' });
    assert.equal(f.records.get(A).version, 3);
  });
  it('projects all effective values into fresh presentation state without modifying stored mg/dL thresholds or another tenant', async function () {
    const f = memory(); await f.service.replace(actor, 1, { DISPLAY_UNITS: 'mmol', customTitle: 'Synthetic',
      alarmHigh: false, alarmHighMins: [20], enable: ['simplealarms'], ...thresholds });
    const base = environment(), b = environment();
    const result = await presentation.forRequest({ reader: { read: () => f.service.read(actor) }, tenant: A, env: base,
      request: { method: 'GET', path: '/status' }, domains: [] });
    assert.equal(result.settings.units, 'mmol'); assert.equal(result.settings.customTitle, 'Synthetic');
    assert.equal(result.settings.alarmHigh, false); assert.deepEqual(result.settings.alarmHighMins, [20]);
    assert.deepEqual(result.settings.thresholds, thresholds); assert.deepEqual(result.settings.enable, ['simplealarms']);
    assert.deepEqual(f.records.get(A).values.bgHigh, 260); assert.equal(base.settings.units, 'mg/dl');
    assert.equal(b.settings.customTitle, 'Nightscout'); assert.deepEqual(f.records.get(B).values, {});
  });
  async function observe (broken = false, change = 'threshold') {
    // The shipping entries query bounds unbounded reads from the wall clock
    // (lib/server/query.js deltaAgo), so the evaluator instant and the synthetic
    // reading follow the real clock instead of a fixed calendar date.
    const at = Date.now();
    const f = memory(), clinical = [{ domain: 'entries', document: { _id: 'synthetic-sgv', type: 'sgv',
      date: at - 60000, sgv: 190, direction: 'Flat' } }];
    const immutableClinical = structuredClone(clinical); let acquisitions = 0, statistics = 0, created = 0;
    const base = { tenant: A, identity: 'a'.repeat(64), env: environment() };
    await f.service.replace(actor, 1, { enable: ['bgnow', 'simplealarms'], ...thresholds, ...(change === 'enable' ? { bgTargetTop: 180 } : {}) });
    const previous = scope.getTenancyMode(); scope.setTenancyMode('multi');
    const runtime = await runtimeFactory({ tenants: [A, B], readCurrent: async tenant => evaluatorConfig.applySettings(
      { ...base, tenant, identity: (tenant === A ? 'a' : 'b').repeat(64) }, await f.service.read({ ...actor, tenant })),
      recoveryIntervalMs: 100, timeIntervalMs: 100, schedule: () => ({}), cancel () {}, now: () => at,
      async create (current) {
        created++;
        const value = evaluatorFactory({ tenant: current.tenant, env: current.env, language: require('../lib/language')(),
          maxRows: 10, maxBytes: 1000000, dbstats: async () => { statistics++; return { dataSize: 0, indexSize: 0 }; },
          replay: { async reconcile () { acquisitions++; return { checkpoint: 7, rows: structuredClone(clinical) }; } },
          // Synthetic SQL read double; actual clinical evaluator/plugins run.
          connection: { async query (sql, params) {
            const encoded = params.at(-1);
            return { rows: typeof encoded === 'string' && encoded.startsWith('[') ? JSON.parse(encoded).sort((a, b) => b.doc.date - a.doc.date) : [] };
          } } });
        if (!broken) return value;
        return { ...value, reconfigure () {} }; // deliberately retains stale threshold settings
      } });
    try {
      const first = runtime.last(A), beforeB = JSON.stringify(runtime.last(B)); assert.equal(first.result.emitted.length, change === 'enable' ? 1 : 0);
      await f.service.replace(actor, 2, { DISPLAY_UNITS: 'mmol', enable: ['bgnow', 'simplealarms'],
        ...thresholds, bgTargetTop: 180, ...(change === 'enable' ? { alarmHigh: false } : {}) });
      assert.equal(await runtime.isCurrent(A, first.identity), false, 'old output loses current authority before next cycle');
      await runtime.tick(A); const current = runtime.last(A);
      assert.equal(current.eligible, true); assert.equal(current.result.trigger, 'time-only');
      assert.equal(acquisitions, 2); assert.equal(statistics, 2); assert.equal(created, 2, 'settings-only change retains committed input');
      assert.equal(JSON.stringify(runtime.last(B)), beforeB, 'A settings transition leaves actual B evaluator output untouched');
      assert.equal(current.result.properties.bgnow.last, 190); assert.deepEqual(clinical, immutableClinical);
      assert.equal(f.records.get(A).values.bgHigh, 260); assert.deepEqual(f.records.get(B).values, {});
      return current.result;
    } finally { await runtime.close(); scope.setTenancyMode(previous); }
  }
  it('actual clinical evaluator consumes committed thresholds on next time cycle without acquisition, unit rewrite or tenant B change', async function () {
    const result = await observe(); assert.equal(result.emitted.length, 1); assert.equal(result.emitted[0].eventName, 'high');
    assert.equal(result.emitted[0].debug.thresholds.bgTargetTop, 180); assert.equal(result.properties.bgnow.last, 190);
  });
  it('actual clinical evaluator consumes committed alarm disable on next time cycle', async function () {
    const result = await observe(false, 'enable'); assert.equal(result.emitted.length, 0);
  });
  it('stale-settings corruption actually suppresses the expected clinical alarm and restoration passes', async function () {
    const broken = await observe(true); assert.equal(broken.emitted.length, 0, 'stale threshold 200 suppresses 190 mg/dL high');
    assert.throws(() => assert.equal(broken.emitted.length, 1), { code: 'ERR_ASSERTION' });
    assert.equal((await observe()).emitted.length, 1);
  });
  it('removing complete-threshold validation makes the independent stored partial-row oracle red', async function () {
    const broken = loadMutation('lib/tenant-settings/catalogue.js',
      "if (count && count !== THRESHOLDS.length)", 'if (false)');
    const file = path.resolve(__dirname, '../lib/tenant-settings/component.js');
    const loaded = new Module(file, module); loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file));
    const original = loaded.require.bind(loaded); loaded.require = name => name === './catalogue' ? broken : original(name);
    loaded._compile(fs.readFileSync(file, 'utf8'), file);
    const f = memory(), corrupted = loaded.exports.createTenantSettings({ store: f.store, policyFor: async () => policy, authorize: async () => true });
    await corrupted.replace(actor, 1, { bgHigh: 200 });
    const stored = f.records.get(A).values;
    assert.deepEqual(stored, { bgHigh: 200 }, 'actual corrupted component commits partial state in synthetic store');
    assert.throws(() => assert.deepEqual(Object.keys(stored).sort(), [...environment.THRESHOLDS].sort()), { code: 'ERR_ASSERTION' });
    const restored = memory(); await assert.rejects(restored.service.replace(actor, 1, { bgHigh: 200 }), { code: 'SETTINGS_VALUE' });
    assert.equal(restored.records.get(A).version, 1); assert.equal(restored.history.size, 0);
  });
  it('appends reviewed migration without changing recorded original bytes and both tables retain independent typed checks', function () {
    const migrations = validateCatalogue(require('../lib/tenant-settings/postgres-candidate.json'));
    assert.equal(migrations[0].checksum, 'aa1cbc036cf23e2930cd08a91ecb5027a9c80fb82dfa0f05ef6e57f06ddab9d2');
    assert.equal(migrations[1].name, '0002_projected_owner_settings');
    assert.equal(migrations[1].up.filter(sql => /ADD CONSTRAINT/.test(sql)).length, 2);
    assert.match(migrations[1].up[0], /BETWEEN 30 AND 600/); assert.match(migrations[1].up[0], /IN \(0,4\)/);
  });
});

describe('explicit owner settings evaluator configuration read composition', function () {
  it('actual load/readCurrent shares committed identities with metadata, closes finite readers and refuses static overlap/outage', async function () {
    const os = require('node:os'), crypto = require('node:crypto');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-settings-config-'));
    const filename = path.join(directory, 'evaluator.json');
    const config = { version: 1, datastore: { hostname: '127.0.0.1', port: 5432, database: 'synthetic_settings' },
      postgres: { connectionEnv: 'CLINICAL', namespaces: Object.fromEntries(['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity', 'clock', 'checkpoint'].map(name => [name, 'clinical_' + name])) },
      consumer: 'evaluator-settings', pageSize: 1, maxRows: 10, maxBytes: 100000, maxTenants: 1,
      recoveryIntervalMs: 100, timeIntervalMs: 100, tenants: [{ id: A, revision: 'one', settings: {} }],
      tenantSettings: { connectionEnv: 'SETTINGS_READER', namespaces: { settings: 'owner_settings', operatorPolicy: 'owner_policy' } } };
    let state = { version: 1, values: { DISPLAY_UNITS: 'mg/dl' } }, opened = 0, closed = 0, refused = false;
    const file = path.resolve(__dirname, '../lib/server/serve/evaluator-config.js');
    const loaded = new Module(file, module); loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file));
    const original = loaded.require.bind(loaded);
    loaded.require = name => name === '../../tenant-settings/effective-postgres' ? async input => {
      opened++; assert.deepEqual(input.namespaces, config.tenantSettings.namespaces);
      return { read: async tenant => {
        assert.equal(tenant, A); if (refused) throw new Error('synthetic unavailable current settings');
        return resolveEffectiveSettings(structuredClone(state), policy);
      }, close: async () => { closed++; } };
    } : original(name);
    loaded._compile(fs.readFileSync(file, 'utf8'), file);
    const password = crypto.randomBytes(12).toString('hex');
    const settingsReader = ['postgres://synthetic-settings:', password, '@127.0.0.1:5432/synthetic_settings'].join('');
    const source = { MULTITENANT_EVALUATOR_CONFIG: filename, SETTINGS_READER: settingsReader,
      CLINICAL: ['postgres://synthetic-clinical:', password, '@127.0.0.1:5432/synthetic_settings'].join('') };
    try {
      fs.writeFileSync(filename, JSON.stringify(config));
      const worker = loaded.exports.load(source), metadata = loaded.exports.loadMetadata({ MULTITENANT_EVALUATOR_CONFIG: filename, SETTINGS_READER: settingsReader });
      const first = await worker.readCurrent(A); assert.equal((await metadata.readCurrent(A)).identity, first.identity);
      state = { version: 2, values: { DISPLAY_UNITS: 'mmol', bgHigh: 260, bgTargetTop: 180, bgTargetBottom: 80, bgLow: 55 } };
      const current = await worker.readCurrent(A); assert.notEqual(current.identity, first.identity);
      assert.equal(current.sourceIdentity, first.sourceIdentity); assert.equal(current.env.settings.units, 'mmol');
      assert.equal((await metadata.readCurrent(A)).identity, current.identity);
      refused = true; await assert.rejects(worker.readCurrent(A), /unavailable/); assert.equal(opened, closed);
      config.tenants[0].settings.showSeconds = true; fs.writeFileSync(filename, JSON.stringify(config));
      assert.throws(() => loaded.exports.load(source), /invalid/);
      delete config.tenants[0].settings.showSeconds;
      config.tenantSettings.extra = true; assert.throws(() => loaded.exports.parseMetadata(config), /invalid/);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
});
