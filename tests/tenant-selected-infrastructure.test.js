'use strict';
// Recording catalogue metadata; native PostgreSQL rendering and DDL/RLS remain unmeasured.
const assert = require('node:assert/strict');
const profiles = require('../lib/pgstream/pool-intake-profile');
const selected = require('../lib/tenant-operations/selected-platform');
const { assertRelationInventory } = require('../lib/storage/postgres-relation-inventory');
const profile = profiles.create({ namespace: 'synthetic_checkpoint', membershipNamespace: 'synthetic_membership', lifecycleNamespace: 'synthetic_control', role: 'synthetic_intake', operatorRole: 'synthetic_operator', consumer: 'evaluator-synthetic', codec: profiles.CODEC, generationDomain: profiles.GENERATION_DOMAIN, sliceRule: require('../lib/pool-membership/slice').RULE });
const literal = value => "'" + value.replace(/'/g, "''") + "'";
const check = 'CHECK ((consumer = ' + literal(profile.binding.consumer + '-completed') + '::text) AND (profile = ' + literal(JSON.stringify(profile.binding)) + '::jsonb) AND (digest = ' + literal(profile.digest) + '::text) AND (contract_digest = ' + literal(profile.contractDigest) + '::text))';
const fail = (code, name) => Object.assign(new Error(code + ':' + name), { code });
function fixture (change = () => {}) {
  const calls = [], rows = ['schema_migrations', 'tenant_consumer_checkpoint', selected.TABLE].map(name => ({ name, kind: 'r', partition: false, inherited: false }));
  const shape = { global: true, owner_safe: true, augmented: false,
    columns: ['consumer', 'profile', 'digest', 'contract_digest'].map(name => ({ name, type: name === 'profile' ? 'jsonb' : 'text', required: true, identity: '', generated: '', default: false })),
    constraints: [{ definition: 'PRIMARY KEY (consumer)', valid: true, deferred: false }, { definition: check, valid: true, deferred: false }] };
  const installed = [{ consumer: profile.binding.consumer + '-completed', profile: profile.binding, digest: profile.digest, contract_digest: profile.contractDigest }];
  change({ rows, shape, installed });
  return { calls, query: async sql => { calls.push(sql); if (sql.includes('reviewed-relation-inventory')) return { rows }; if (sql.includes('selected-global-profile-shape')) return { rows: [shape] }; if (sql.includes('selected-global-profile-current')) return { rows: installed }; throw new Error('Unexpected SQL'); } };
}
const options = infrastructure => ({ namespace: profile.binding.namespace, tables: ['tenant_consumer_checkpoint'], infrastructure, fail });
describe('selected platform global infrastructure admission', function () {
  it('admits only a source-branded exact global profile without adopting it as tenant data', async function () {
    const declaration = selected.declaration(profile), f = fixture();
    await assertRelationInventory(f, options(declaration)); assert.equal(f.calls.length, 3);
    assert(Object.isFrozen(declaration)); assert(selected.recognizes(declaration));
    assert(!selected.recognizes({ ...declaration })); assert(!options(declaration).tables.includes(selected.TABLE));
  });
  it('requires the selected global relation and refuses an artifact-like forged declaration', async function () {
    await assert.rejects(assertRelationInventory(fixture(({ rows }) => { rows.pop(); }), options(selected.declaration(profile))), { code: 'MISSING' });
    await assert.rejects(assertRelationInventory(fixture(), options({ ...selected.declaration(profile) })), { code: 'INVALID' });
    await assert.rejects(assertRelationInventory(fixture(), options(null)), { code: 'UNADMITTED' });
  });
  it('refuses changed physical shape, ownership, global row, checks and unknown relations', async function () {
    for (const change of [({ shape }) => { shape.global = false; }, ({ shape }) => { shape.owner_safe = false; }, ({ shape }) => { shape.augmented = true; },
      ({ shape }) => { shape.columns[0].default = true; }, ({ shape }) => { shape.constraints[1].definition = check.replace(' AND ', ' OR '); },
      ({ shape }) => { shape.constraints[1].definition = check.replace(profile.digest, 'a'.repeat(64)); }, ({ shape }) => { shape.constraints[0].deferred = true; }]) {
      await assert.rejects(assertRelationInventory(fixture(change), options(selected.declaration(profile))), { code: 'INFRASTRUCTURE_UNSUPPORTED' });
    }
    for (const change of [({ installed }) => { installed.length = 0; }, ({ installed }) => { installed[0].digest = 'b'.repeat(64); }, ({ installed }) => { installed.push(installed[0]); },
      ({ installed }) => { installed[0].profile = { ...profile.binding, consumer: 'evaluator-other' }; }]) await assert.rejects(assertRelationInventory(fixture(change), options(selected.declaration(profile))), { code: 'INFRASTRUCTURE_CHANGED' });
    await assert.rejects(assertRelationInventory(fixture(({ rows }) => rows.push({ name: 'unknown', kind: 'r', partition: false, inherited: false })), options(selected.declaration(profile))), { code: 'UNADMITTED' });
  });
  it('makes missing required global infrastructure red when the required-inventory addition is removed', async function () {
    const fs = require('node:fs'), Module = require('node:module'), path = require('node:path');
    const filename = require.resolve('../lib/storage/postgres-relation-inventory'), source = fs.readFileSync(filename, 'utf8');
    const guard = 'if (globalProfile) expected.add(infrastructure.table);'; assert.equal(source.split(guard).length, 2);
    const altered = new Module(filename, module); altered.filename = filename; altered.paths = Module._nodeModulePaths(path.dirname(filename)); altered._compile(source.replace(guard, ''), filename);
    let red = false;
    try { await assert.rejects(altered.exports.assertRelationInventory(fixture(({ rows }) => { rows.pop(); }), options(selected.declaration(profile)))); }
    catch (error) { assert.equal(error.code, 'ERR_ASSERTION'); assert.match(error.message, /Missing expected rejection/); red = true; }
    assert(red); await assert.rejects(assertRelationInventory(fixture(({ rows }) => { rows.pop(); }), options(selected.declaration(profile))), { code: 'MISSING' });
  });
});
