'use strict';
// Source/SQL protocol only. RLS, activation, physical leases and COMMIT are native criteria.
const assert = require('node:assert/strict');
const authority = require('../lib/tenant-lifecycle/pool-authority');
const extension = require('../lib/tenant-lifecycle/recommission-candidate');
const { profile, A, B } = require('./fixtures/lifecycle-domain-profile');
describe('current tenant lifecycle authority for the worker pool', function () {
  const { read } = authority.create({ namespace: 'synthetic_control' });
  const row = () => ({ tenant: A, generation: '9', phase: 'active', bound: true, deletion: false });
  const query = value => async (text, values) => {
    assert(text.startsWith('SELECT')); assert.deepEqual(values, [A]);
    assert(text.includes("current_setting('app.current_tenant_id',true)"));
    return { rows: value };
  };
  it('reads current physical generation and lifecycle eligibility independently of any roster', async function () {
    assert.deepEqual(await read(query([row()]), A), { tenant: A, identity: A, generation: '9', eligibility: 'active' });
    assert.equal((await read(query([{ ...row(), deletion: true }]), A)).eligibility, 'deleted');
    assert.equal((await read(query([{ ...row(), phase: 'suspended' }]), A)).eligibility, 'suspended');
    assert(Object.isFrozen(await read(query([row()]), A)));
  });
  it('refuses unknown, foreign, unbound and unsupported generation/state observations', async function () {
    for (const rows of [[], [row(), row()], [{ ...row(), tenant: B }], [{ ...row(), bound: false }], [{ ...row(), generation: '0' }], [{ ...row(), generation: '4611686018427387903' }], [{ ...row(), deletion: null }], [{ ...row(), phase: 'deleted' }]]) {
      await assert.rejects(read(query(rows), A), { code: 'LIFECYCLE_POOL_AUTHORITY_REFUSED' });
    }
  });
  it('requires exact executed-request artifact and activated generation linkage without reading private restore audit', function () {
    const sql = authority.sql('synthetic_control');
    for (const term of ['d.artifact_digest=x.artifact_digest', "d.phase='executed'", 'x.activated', 'x.generation<=w.generation']) assert(sql.includes(term));
    assert(!sql.includes('tenant_lifecycle_restore_audit'));
    assert(!sql.includes('pool_membership'));
    assert(Object.isFrozen(authority.READS[extension.TABLE]));
    assert(authority.grants({ namespace: 'synthetic_control', role: 'synthetic_reader' }).every(grant => grant.startsWith('GRANT SELECT (')));
  });
  it('appends exact recommission schema without rewriting the selected-v1 prefix', function () {
    const base = require('../lib/tenant-lifecycle/generation-domain').catalogue(profile());
    const selected = extension.extend(base);
    assert.deepEqual(selected.migrations.slice(0, -1), base.migrations);
    assert.equal(selected.migrations.at(-1).name, '0011_exact_artifact_recommission');
    const up = selected.migrations.at(-1).up.join('\n');
    for (const term of ['FORCE ROW LEVEL SECURITY', 'activated = false', 'activated = true', "d.phase = 'executed'", "k.phase = 'retained'", "r.state = 'suspended'", "r.state = 'activated'", "s.interrupted = 'data-replaced'"]) assert(up.includes(term), term);
    assert(!up.includes('private_key')); assert(!up.includes('last_stamp'));
    assert.throws(() => extension.extend(selected), /ALREADY_SELECTED/);
  });
  it('makes an omitted physical tenant-binding guard red, then restores the refusal', async function () {
    const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
    const filename = require.resolve('../lib/tenant-lifecycle/pool-authority');
    // Exact source-owned module; read-only ablation compiled in memory.
    const source = fs.readFileSync(filename, 'utf8'), guard = 'rows[0].bound !== true ||';
    assert.equal(source.split(guard).length, 2);
    const compiled = new Module(filename, module); compiled.filename = filename; compiled.paths = Module._nodeModulePaths(path.dirname(filename));
    compiled._compile(source.replace(guard, ''), filename);
    let red = false;
    try { await assert.rejects(compiled.exports.create({ namespace: 'synthetic_control' }).read(query([{ ...row(), bound: false }]), A)); }
    catch (error) { assert.equal(error.code, 'ERR_ASSERTION'); assert.match(error.message, /Missing expected rejection/); red = true; }
    assert(red, 'physical binding omission must invalidate the refusal oracle');
    await assert.rejects(read(query([{ ...row(), bound: false }]), A), { code: 'LIFECYCLE_POOL_AUTHORITY_REFUSED' });
  });
  it('admits only exact v2 link layout, tenant RLS and operator column capabilities', function () {
    const readiness = require('../lib/tenant-lifecycle/recommission-readiness');
    const metadata = maintenance => ({ oid: 70, kind: 'r', persistence: 'p', secured: true, owns: false, reads: maintenance,
      broad_writes: false, triggers: false, rules: false, inherited: false, bad_indexes: false, dropped: false, owner_safe: true,
      columns: readiness.LAYOUT.map(([name, type, not_null, expression]) => ({ name, type, not_null, identity: '', generated: '', default: expression || null,
        reads: maintenance || authority.READS[extension.TABLE].includes(name), inserts: maintenance && readiness.INSERT.includes(name), updates: maintenance && name === 'activated' })),
      constraints: readiness.CONSTRAINTS.map(definition => ({ definition, valid: true, deferrable: false })),
      policies: readiness.policies().map(policy => ({ ...policy, roles: [0], permissive: true })) });
    for (const maintenance of [false, true]) {
      readiness.validate(metadata(maintenance), 'synthetic_control', maintenance);
      for (const change of [value => { value.secured = false; }, value => { value.policies[2].check = 'true'; }, value => { value.columns[2].reads = !maintenance; }, value => { value.columns[0].inserts = !maintenance; }, value => { value.constraints.pop(); }]) {
        const altered = metadata(maintenance); change(altered);
        assert.throws(() => readiness.validate(altered, 'synthetic_control', maintenance), { code: 'LIFECYCLE_WINDOW_SCHEMA_UNSAFE' });
      }
    }
    assert(readiness.operatorGrants({ namespace: 'synthetic_control', role: 'synthetic_operator' }).every(grant => !/DELETE|TRUNCATE|REFERENCES|TRIGGER/.test(grant)));
  });
});
