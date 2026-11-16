'use strict';
// Recording SQL ports; physical locks, registry RLS and COMMIT remain native criteria.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const registry = require('../lib/tenant-registry/recommission');
const rules = require('../lib/tenant-registry/rules');
const A = '11111111-1111-4111-8111-111111111111';
function fixture (changes = {}) {
  const calls = [], observation = { tenant: A, generation: '8', phase: 'active', bound: true, deletion: true, ...changes.authority };
  const query = async (sql, values) => {
    calls.push({ sql, values }); assert.deepEqual(values, sql.includes('removal-shared-lifetime') ? [rules.lockKey(A)] : [A]);
    if (sql.includes('removal-current-lifetime')) return { rows: changes.window === null ? [] : [{ key: rules.lockKey(A), phase: 'active', claim_id: null, ...changes.window }] };
    if (sql.includes('removal-shared-lifetime')) return { rows: [{ held: changes.held !== false }] };
    if (sql.includes('pool-lifecycle-authority')) return { rows: [observation] };
    if (sql.includes('removal-current-execution')) return { rows: [{ executed: changes.executed !== false }] };
    throw new Error('Unexpected SQL');
  };
  return { query, calls };
}
const options = { namespace: 'synthetic_control', tenant: A };
describe('same-ID registry removal admission', function () {
  it('takes a nonblocking shared lifetime before requiring current unsuperseded execution', async function () {
    const f = fixture(); assert.equal(await registry.removalAdmission(f.query, options), true);
    assert.equal(f.calls.length, 4); assert(f.calls[1].sql.includes('pg_try_advisory_xact_lock_shared'));
    const executed = f.calls[3].sql;
    for (const term of ["r.phase='executed'", "c.phase='executed'", 'NOT EXISTS', 'x.activated', 'x.generation<=w.generation', 'd.artifact_digest=x.artifact_digest']) assert(executed.includes(term));
    assert(f.calls.every(call => !/FOR UPDATE|UPDATE |DELETE |INSERT /.test(call.sql)));
  });
  it('refuses a held maintenance window, wrong lock, absent window, pending deletion and superseded execution', async function () {
    for (const changes of [{ window: null }, { window: { key: '1' } }, { window: { phase: 'suspended' } }, { window: { claim_id: A } }, { held: false }, { authority: { deletion: false } }, { executed: false }]) {
      const f = fixture(changes); assert.equal(await registry.removalAdmission(f.query, options), false);
    }
    const f = fixture({ held: false }); await registry.removalAdmission(f.query, options); assert.equal(f.calls.length, 2);
  });
  it('refuses a foreign or unbound current authority observation', async function () {
    for (const changes of [{ authority: { tenant: '22222222-2222-4222-8222-222222222222' } }, { authority: { bound: false } }]) {
      await assert.rejects(registry.removalAdmission(fixture(changes).query, options), { code: 'LIFECYCLE_POOL_AUTHORITY_REFUSED' });
    }
  });
  it('makes omission of the current-execution result red and restores refusal', async function () {
    const filename = require.resolve('../lib/tenant-registry/recommission'), source = fs.readFileSync(filename, 'utf8');
    const guard = 'executed.length === 1 && executed[0].executed === true'; assert.equal(source.split(guard).length, 2);
    const altered = new Module(filename, module); altered.filename = filename; altered.paths = Module._nodeModulePaths(path.dirname(filename));
    altered._compile(source.replace(guard, 'true'), filename);
    let red = false;
    try { assert.equal(await altered.exports.removalAdmission(fixture({ executed: false }).query, options), false); }
    catch (error) { assert.equal(error.code, 'ERR_ASSERTION'); red = true; }
    assert(red); assert.equal(await registry.removalAdmission(fixture({ executed: false }).query, options), false);
  });
});

describe('same-ID current-configuration registry reconstruction', function () {
  function admitted () {
    const filename = require.resolve('../lib/tenant-registry/recommission');
    const compiled = new Module(filename, module); compiled.filename = filename; compiled.paths = Module._nodeModulePaths(path.dirname(filename));
    const originalRequire = compiled.require.bind(compiled), calls = [];
    compiled.require = name => name === '../tenant-lifecycle/maintenance-window' ? { assertHeld: async (claim, expected) => {
      calls.push(expected); if (claim !== 'recording-claim') throw new Error('recording claim refused');
    } } : originalRequire(name);
    compiled._compile(fs.readFileSync(filename, 'utf8'), filename);
    return { port: compiled.exports.create({ namespace: 'synthetic_registry', controlNamespace: 'synthetic_control' }), calls };
  }
  function data (changes = {}) {
    const calls = [];
    const query = async (sql, values) => {
      calls.push({ sql, values });
      if (sql.includes('recommission-current-registry')) return { rows: [{ tenant: A, state: 'removed', signing_version: 3, ...changes.registry }] };
      if (sql.startsWith('SELECT host,kind')) return { rows: changes.hosts || [] };
      if (sql.startsWith('INSERT INTO')) return { rowCount: 1 };
      if (sql.startsWith('UPDATE')) return { rowCount: 1 };
      if (sql.startsWith('SELECT tenant_id')) return { rows: [{ tenant: A, purpose: 'access', kid: 'current_key', public_key: 'current-registry-public-reference' }] };
      throw new Error('Unexpected SQL');
    };
    return { connection: { query }, calls };
  }
  const input = { tenant: A, maintenanceClaim: 'recording-claim', artifactDigest: 'a'.repeat(64), configuration: { hosts: ['synthetic.example.invalid'] } };
  it('uses only explicit current hosts, retains registry signing version and rechecks the actual admission port', async function () {
    const f = data(), module = admitted();
    const result = await module.port.register(f.connection, input);
    assert.equal(result.signingVersion, 3); assert.equal(result.keys[0].kid, 'current_key');
    assert.equal(module.calls.length, 2); assert(module.calls.every(call => call.connection === f.connection && call.artifactDigest === input.artifactDigest));
    assert.deepEqual(f.calls.find(call => call.sql.startsWith('INSERT')).values, ['synthetic.example.invalid', A, 'alias']);
    assert(f.calls.every(call => !/DELETE|UPSERT|ON CONFLICT|SET signing_version/.test(call.sql)));
  });
  it('preserves matching current hosts and refuses changed current hosts or absent configuration', async function () {
    const present = data({ hosts: [{ host: 'synthetic.example.invalid', kind: 'alias' }], registry: { state: 'active' } });
    await admitted().port.register(present.connection, input);
    assert(present.calls.every(call => !/^(INSERT|UPDATE)/.test(call.sql)));
    await assert.rejects(admitted().port.register(data({ hosts: [{ host: 'other.example.invalid', kind: 'alias' }] }).connection, input), { code: 'LIFECYCLE_RECOMMISSION_CURRENT_HOSTS_CONFLICT' });
    await assert.rejects(admitted().port.register(data().connection, { ...input, configuration: undefined }), { code: 'LIFECYCLE_RECOMMISSION_CURRENT_HOSTS_REQUIRED' });
  });
  it('refuses an unadmitted caller before registry reads and a foreign current registry row before writes', async function () {
    const f = data(); await assert.rejects(admitted().port.register(f.connection, { ...input, maintenanceClaim: null }), /recording claim refused/); assert.equal(f.calls.length, 0);
    const foreign = data({ registry: { tenant: '22222222-2222-4222-8222-222222222222' } });
    await assert.rejects(admitted().port.register(foreign.connection, input), { code: 'LIFECYCLE_RECOMMISSION_REGISTRY_REQUIRED' }); assert.equal(foreign.calls.length, 1);
  });
});
