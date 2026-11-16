'use strict';
// Source SQL grant composition; PostgreSQL effective privilege/RLS checks remain native.
const assert = require('node:assert/strict');
const profiles = require('../lib/pgstream/pool-intake-profile');
const grants = require('../lib/tenant-lifecycle/recommission-grants');
const namespaces = Object.fromEntries(require('../lib/tenant-lifecycle').admittedCatalogue().map(entry => [entry.kind, 'synthetic_' + entry.kind]));
const profile = profiles.create({ namespace: namespaces.checkpoint, membershipNamespace: 'synthetic_membership', lifecycleNamespace: 'synthetic_control', role: 'synthetic_intake', operatorRole: 'synthetic_assignment', consumer: 'evaluator-synthetic', codec: profiles.CODEC, generationDomain: profiles.GENERATION_DOMAIN, sliceRule: require('../lib/pool-membership/slice').RULE });
const input = () => ({ catalogues: require('../lib/tenant-lifecycle').admittedCatalogue().map(entry => entry.kind === 'checkpoint' ? { ...entry, candidate: require('../lib/pgstream/pool-catalogue').build(profile).catalogue } : entry),
  namespaces, registryNamespace: 'synthetic_registry', intakeProfile: profile, role: 'synthetic_maintenance' });
describe('private recommission source grants', function () {
  it('grants source reconstruction and current commissioning to a distinct maintenance identity', function () {
    const sql = grants.build(input()); assert(Object.isFrozen(sql)); assert(sql.length > 0);
    assert(sql.every(value => /(?:TO|FROM) "synthetic_maintenance"$/.test(value)));
    assert(sql.some(value => value.includes('INSERT(request_id,tenant_id,artifact_digest,key_names,key_references,phase,retained_at,retain_until)')));
    assert(sql.some(value => value.includes('INSERT(' + require('../lib/pgstream/pool-checkpoint-provision-candidate').INSERTS.join(',') + ')')));
    assert(sql.some(value => value.includes('tenant_settings_values_valid"(jsonb)')));
    assert(sql.every(value => !/ALL TABLES|TRUNCATE|REFERENCES|TRIGGER|^CREATE|^ALTER/.test(value)));
    assert(sql.filter(value => value.includes('pool_desired')).every(value => value.startsWith('GRANT SELECT(')));
    assert(sql.filter(value => value.includes('pgstream_intake_profile')).every(value => value.startsWith('GRANT SELECT(')));
    assert(sql.filter(value => value.includes('tenant_lifecycle_restore_authority')).every(value => value.startsWith('GRANT SELECT')));
  });
  it('keeps retained-key destruction a separate explicit capability', function () {
    assert(grants.build(input()).every(sql => !sql.includes('UPDATE(destroy_started_by')));
    const destructive = grants.build({ ...input(), destroyRetainedKeys: true });
    assert.equal(destructive.filter(sql => sql.includes('UPDATE(destroy_started_by')).length, 1);
    assert.throws(() => grants.build({ ...input(), destroyRetainedKeys: 'true' }));
  });
  it('refuses intake/assignment identities, unknown tables, shared namespaces and an unselected checkpoint catalogue', function () {
    for (const role of [profile.binding.role, profile.binding.operatorRole]) assert.throws(() => grants.build({ ...input(), role }));
    const unselected = input(); unselected.catalogues = require('../lib/tenant-lifecycle').admittedCatalogue(); assert.throws(() => grants.build(unselected), /Exact selected checkpoint/);
    const unknown = input(); unknown.catalogues[0] = { ...unknown.catalogues[0], tables: ['unknown_table'] }; assert.throws(() => grants.build(unknown));
    assert.throws(() => grants.build({ ...input(), namespaces: { ...namespaces, treatments: namespaces.entries } }));
  });
  it('makes the intake-identity refusal red when that identity guard is omitted and restores it', function () {
    const fs = require('node:fs'), Module = require('node:module'), path = require('node:path');
    const filename = require.resolve('../lib/tenant-lifecycle/recommission-grants'), source = fs.readFileSync(filename, 'utf8');
    const guard = '[b.role, b.operatorRole].includes(role)'; assert.equal(source.split(guard).length, 2);
    const broken = new Module(filename, module); broken.filename = filename; broken.paths = Module._nodeModulePaths(path.dirname(filename)); broken._compile(source.replace(guard, 'false'), filename);
    let red = false; const value = { ...input(), role: profile.binding.role };
    try { assert.throws(() => broken.exports.build(value)); } catch (error) { assert.equal(error.code, 'ERR_ASSERTION'); assert.match(error.message, /Missing expected exception/); red = true; }
    assert(red); assert.throws(() => grants.build(value));
  });
});
