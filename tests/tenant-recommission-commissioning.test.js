'use strict';
// Recording SQL/configuration controls; positive claims are explicit stand-ins.
// Native operator/owner/credential usability is not established by these tests.
// covers: lib/tenant-lifecycle/recommission-commissioning.js
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const helper = require('../lib/tenant-lifecycle/recommission-commissioning');
const maintenance = require('../lib/tenant-lifecycle/maintenance-window');
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const DIGEST = 'a'.repeat(64), clone = value => JSON.parse(JSON.stringify(value));
const namespaces = Object.fromEntries(['control', 'registry', 'authorization', 'access', 'subject_policy', 'operator_policy', 'owner_configuration'].map(kind => [kind, 'commission_' + kind]));
const publicKey = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
const selected = [
  { purpose: 'access', kid: 'data_current', publicKey }, { purpose: 'management', kid: 'management_current', publicKey },
  { purpose: 'human-data', kid: 'human_data_current', publicKey }, { purpose: 'human-management', kid: 'human_management_current', publicKey }
];
const grant = { principal: 'runtime', consumer: 'serve', operation: 'decrypt', id: 'root' };
function configuration () {
  return { actor: { principal: 'operator', consumer: 'private_admin' }, eventTime: 3000,
    operatorPolicy: { deployment: {}, overrides: {} }, ownerCatalogue: ['api:entries:read'],
    ownerActors: [{ principal: 'owner', consumer: 'management', active: true, canUpdate: true, delegable: ['api:entries:read'] }],
    ownerConfiguration: [{ principal: 'owner', consumer: 'settings', active: true, canConfigure: true }],
    subjectPolicy: { grants: [clone(grant)], code: [clone(grant)], operator: [clone(grant)] }, access: { active: true, keys: clone(selected) } };
}
function fixture () {
  const state = { rows: new Map(), trace: [], authority: true, held: true, claims: 0 };
  state.registry = [...selected.map(key => ({ tenant_id: A, purpose: key.purpose, kid: key.kid, public_key: key.publicKey })),
    { tenant_id: A, purpose: 'access', kid: 'historical', public_key: publicKey }];
  const connection = { async query (sql, values) {
    state.trace.push({ sql, values: clone(values) });
    assert.equal(values[0], A, 'all statements bind the selected tenant');
    if (sql.includes('recommission-current-authority')) return { rows: [{ active: state.authority }] };
    if (sql.includes('tenant_registry_keys')) return { rows: clone(state.registry) };
    const match = /(?:FROM|INTO) "([a-z_]+)"\."([a-z_]+)"/.exec(sql);
    assert(match, sql); const key = match[1] + '.' + match[2];
    if (sql.startsWith('SELECT')) return { rows: clone((state.rows.get(key) || []).filter(row => row.tenant_id === A)) };
    assert(sql.startsWith('INSERT INTO'), 'commissioning never updates/deletes current rows');
    const columns = / \(([^)]+)\) VALUES/.exec(sql)[1].replaceAll('"', '').split(',');
    const row = Object.fromEntries(columns.map((name, index) => [name, ['policy', 'grants'].includes(name) ? JSON.parse(values[index]) : clone(values[index])]));
    const rows = state.rows.get(key) || []; rows.push(row); state.rows.set(key, rows);
    return { rows: [], rowCount: state.writeRefused ? 0 : 1 };
  } };
  const token = Object.freeze({ synthetic: true });
  const args = { connection, maintenanceClaim: token, tenant: A, artifactDigest: DIGEST, namespaces, configuration: configuration() };
  return { state, args };
}
async function withRecordingClaim (f, fn) {
  const original = maintenance.assertHeld;
  maintenance.assertHeld = async (token, claim) => {
    f.state.claims++;
    assert.equal(token, f.args.maintenanceClaim); assert.equal(claim.connection, f.args.connection);
    assert.equal(claim.tenant, A); assert.equal(claim.artifactDigest, DIGEST);
    if (!f.state.held) throw Object.assign(new Error('lost'), { code: 'LIFECYCLE_RESTORE_CLAIM_INVALID' });
  };
  try { return await fn(); } finally { maintenance.assertHeld = original; }
}
const writes = f => f.state.trace.filter(row => row.sql.startsWith('INSERT'));
function altered (guard, replacement) {
  const file = path.resolve(__dirname, '../lib/tenant-lifecycle/recommission-commissioning.js');
  const source = fs.readFileSync(file, 'utf8'); assert.equal(source.split(guard).length, 2);
  const compiled = new Module(file, module); compiled.filename = file; compiled.paths = Module._nodeModulePaths(path.dirname(file));
  compiled._compile(source.replace(guard, replacement), file); return compiled.exports;
}

describe('current-configuration recommission commissioning (recording protocol)', function () {
  it('uses the real branded claim rejection before any SQL and never accepts a fabricated token', async function () {
    const f = fixture();
    await assert.rejects(helper.commission(f.args), { code: 'LIFECYCLE_RESTORE_CLAIM_INVALID' });
    assert.equal(f.state.trace.length, 0);
  });

  it('requires active current operator role authority before reading configuration tables or writing', async function () {
    const f = fixture(); f.state.authority = false;
    await withRecordingClaim(f, async () => assert.rejects(helper.commission(f.args), { code: 'LIFECYCLE_COMMISSION_AUTHORITY_REFUSED' }));
    assert.equal(f.state.trace.length, 1); assert.equal(writes(f).length, 0);
  });

  it('rebuilds erased current configuration and explicitly selected current keys, excluding retained historical keys', async function () {
    const f = fixture();
    const result = await withRecordingClaim(f, () => helper.commission(f.args));
    assert.equal(result.inserted.length, 7); assert.equal(result.preserved.length, 0); assert(Object.isFrozen(result.inserted));
    assert.equal(writes(f).length, 10); assert.equal(f.state.claims, writes(f).length + 2);
    const policy = f.state.rows.get('commission_operator_policy.tenant_operator_policy')[0];
    assert.deepEqual(policy.policy, { deployment: {}, overrides: {} }); assert.equal(policy.event_time, '3000');
    const keys = f.state.rows.get('commission_access.access_keys');
    assert.deepEqual(keys.map(row => [row.kid, row.purpose, row.active]), selected.map(key => [key.kid, key.purpose.includes('management') ? 'management' : 'data', true]));
    assert(!keys.some(key => key.kid === 'historical'));
    assert.deepEqual(f.state.rows.get('commission_subject_policy.subject_policy')[0].grants, [grant]);
    assert.equal(f.state.rows.get('commission_authorization.tenant_owner_actors')[0].can_update, true);
    assert.equal(f.state.rows.get('commission_owner_configuration.tenant_owner_configuration_authority')[0].can_configure, true);
  });

  it('preserves every existing group byte-for-byte without requiring replacement configuration; preserves B', async function () {
    const f = fixture(); await withRecordingClaim(f, () => helper.commission(f.args));
    for (const rows of f.state.rows.values()) rows.push({ tenant_id: B, synthetic: 'preserve B' });
    const before = clone([...f.state.rows]); f.state.trace = []; f.args.configuration = undefined;
    const result = await withRecordingClaim(f, () => helper.commission(f.args));
    assert.equal(result.inserted.length, 0); assert.equal(result.preserved.length, 7); assert.equal(writes(f).length, 0);
    assert.deepEqual([...f.state.rows], before);
  });

  it('preserves present disabled access and current settings while commissioning only missing groups', async function () {
    const f = fixture();
    f.state.rows.set('commission_access.access_tenants', [{ tenant_id: A, active: false }]);
    f.state.rows.set('commission_access.access_keys', [{ tenant_id: A, kid: 'current_disabled', purpose: 'data', active: false }]);
    f.state.rows.set('commission_operator_policy.tenant_operator_policy', [{ tenant_id: A, generation: 9,
      policy: { deployment: {}, overrides: {} }, principal: 'current_operator', consumer: 'private_admin', event_time: '7000' }]);
    const before = clone([...f.state.rows]);
    delete f.args.configuration.access; delete f.args.configuration.operatorPolicy;
    const result = await withRecordingClaim(f, () => helper.commission(f.args));
    assert.equal(result.preserved.length, 3); assert.equal(result.inserted.length, 4);
    for (const [key, rows] of before) assert.deepEqual(f.state.rows.get(key), rows);
    assert(!f.state.trace.some(row => row.sql.includes('tenant_registry_keys')), 'no replacement key selection for a present access group');
  });

  it('refuses each omitted current configuration/capability before its first write', async function () {
    for (const key of ['actor', 'eventTime', 'operatorPolicy', 'ownerCatalogue', 'ownerActors', 'ownerConfiguration', 'subjectPolicy', 'access']) {
      const f = fixture(); delete f.args.configuration[key];
      await withRecordingClaim(f, async () => assert.rejects(helper.commission(f.args), { code: 'LIFECYCLE_COMMISSION_CONFIGURATION_REQUIRED' }));
      assert.equal(writes(f).length, 0, key);
    }
    for (const key of ['code', 'operator', 'grants']) {
      const f = fixture(); delete f.args.configuration.subjectPolicy[key];
      await withRecordingClaim(f, async () => assert.rejects(helper.commission(f.args), { code: 'LIFECYCLE_COMMISSION_CAPABILITY_REQUIRED' }));
      assert.equal(writes(f).length, 0);
    }
    const f = fixture(); delete f.args.configuration.access.keys;
    await withRecordingClaim(f, async () => assert.rejects(helper.commission(f.args), { code: 'LIFECYCLE_COMMISSION_CAPABILITY_REQUIRED' }));
    assert.equal(writes(f).length, 0);
  });

  it('uses actual settings, owner implication and exact subject-grant validators before writes', async function () {
    for (const change of [
      config => { config.operatorPolicy.deployment.unknown_setting = { mode: 'open' }; },
      config => { config.ownerActors[0].delegable = ['api:entries:delete']; },
      config => { config.ownerCatalogue = ['has whitespace']; },
      config => { config.subjectPolicy.operator = []; },
      config => { config.subjectPolicy.grants[0].operation = 'unknown'; },
      config => { config.subjectPolicy.grants.push(clone(grant)); },
      config => { config.ownerConfiguration[0].canConfigure = 'true'; }
    ]) {
      const f = fixture(); change(f.args.configuration);
      await withRecordingClaim(f, async () => assert.rejects(helper.commission(f.args)));
      assert.equal(writes(f).length, 0);
    }
  });

  it('refuses missing, mismatched, duplicate or unsupported configured current key capabilities', async function () {
    for (const change of [
      f => { f.state.registry = []; }, f => { f.args.configuration.access.keys[0].publicKey = Buffer.alloc(32, 7).toString('base64'); },
      f => { f.args.configuration.access.keys[0].purpose = 'data'; },
      f => { f.args.configuration.access.keys.push(clone(f.args.configuration.access.keys[0])); },
      f => { f.args.configuration.access.keys = []; }
    ]) {
      const f = fixture(); change(f);
      await withRecordingClaim(f, async () => assert.rejects(helper.commission(f.args)));
      assert.equal(writes(f).length, 0);
    }
  });

  it('rechecks the bound claim before any insert and refuses writes not acknowledged once', async function () {
    const f = fixture(), query = f.args.connection.query;
    f.args.connection.query = async (sql, values) => { const result = await query(sql, values); if (sql.includes('tenant_registry_keys')) f.state.held = false; return result; };
    await withRecordingClaim(f, async () => assert.rejects(helper.commission(f.args), { code: 'LIFECYCLE_RESTORE_CLAIM_INVALID' }));
    assert.equal(writes(f).length, 0);
    const rejected = fixture(); rejected.state.writeRefused = true;
    await withRecordingClaim(rejected, async () => assert.rejects(helper.commission(rejected.args), { code: 'LIFECYCLE_COMMISSION_WRITE_REFUSED' }));
    assert.equal(writes(rejected).length, 1, 'outer transaction must roll back the refused write');
  });

  it('exports column-only SELECT/INSERT grants, no UPDATE/DELETE/EXECUTE or archive access', function () {
    const sql = helper.grants({ namespaces, role: 'restore_operator' });
    assert(sql.some(text => text.includes('tenant_registry_keys')));
    assert(sql.every(text => !/\b(UPDATE|DELETE|TRUNCATE|EXECUTE|PUBLIC)\b/.test(text)));
    assert(sql.filter(text => text.includes('INSERT')).every(text => /GRANT SELECT \([^)]+\), INSERT \([^)]+\)/.test(text)));
    assert.throws(() => helper.grants({ namespaces: { ...namespaces, registry: 'public' }, role: 'restore_operator' }));
  });

  it('control: omitted current-key match accepts an unregistered capability; restored source refuses before writes', async function () {
    const broken = altered("if (matched.length !== 1 || seen.has(identity)) fail('KEY_INVALID');", '');
    const f = fixture(); f.args.configuration.access.keys[0].publicKey = Buffer.alloc(32, 9).toString('base64');
    await withRecordingClaim(f, async () => {
      await assert.rejects(assert.rejects(broken.commission(f.args)), /Missing expected rejection/);
    });
    assert(writes(f).length > 0, 'red control admitted a key outside the current registry');
    const restored = fixture(); restored.args.configuration.access.keys[0].publicKey = Buffer.alloc(32, 9).toString('base64');
    await withRecordingClaim(restored, async () => assert.rejects(helper.commission(restored.args), { code: 'LIFECYCLE_COMMISSION_KEY_INVALID' }));
    assert.equal(writes(restored).length, 0);
  });

  it('control: omitted initial branded-claim guard exposes SQL to a forged token; restored source exposes none', async function () {
    const broken = altered('  await maintenance.assertHeld(maintenanceClaim, claim);\n  if (!UUID', '  if (!UUID');
    const f = fixture();
    await assert.rejects(broken.commission(f.args), { code: 'LIFECYCLE_RESTORE_CLAIM_INVALID' });
    assert.throws(() => assert.equal(f.state.trace.length, 0), assert.AssertionError);
    const restored = fixture(); await assert.rejects(helper.commission(restored.args), { code: 'LIFECYCLE_RESTORE_CLAIM_INVALID' });
    assert.equal(restored.state.trace.length, 0);
  });
});
