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
