'use strict';
// covers: lib/migrations/catalogue.js, lib/migrations/postgres.js
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { checksum, validateCatalogue, renderMigration, operationTables, INSERTION_NAMESPACE } = require('../lib/migrations/catalogue');
const builder = require('../lib/tenant-lifecycle/tenant-insertion-sql');
const PREFIX = {
  entries: [2, '4194af3d3b573d8802b44b6c6dc572725e8115cec540473eb5091afe5d03e24a'],
  food: [1, '6783c5523388b27baee6f1e74174fbb270ce418e852e9fed178b0d8c8315ce38'],
  treatments: [2, 'd4c05fcfc04a11b732df4b11747ce35dd95a236c9c0ec6f8606a11964039c8b7'],
  devicestatus: [2, 'a0625ebb5ddf0e938c94e4abe8b07f39ac00108ca441c0afd7bb22b98da64c03'],
  profile: [2, '919166cd5fdfa5608e4a178766b1cf2e6f1c101cd24bededc59d02a1d88853d0']
};
const CONVERSION_PREFIX = {
  entries: '081db90cb044621717701fed54585a7f9ee3db90b1c7f3cb598a95268b19dfda',
  food: 'e7e3f1750325c449cfa8a52953217e78b591a8ae1594df779c6be0d20f5b3e27',
  treatments: '5d03cb6722f33989842f7403b5c9b227c99421dc89abbd6ab53b82b9322229de',
  devicestatus: '2429bb675ab82769dc016de0f73f30c08052f604dfa510da4acfbe5ca6d732ff',
  profile: '1392378ac0e969f8dbd0f4787d1e1525af0e703d61abfbe2dea7e87f67ca80e2'
};
const CANDIDATES = {
  entries: require('../migrations/candidates/postgres-entries-v1.json'),
  food: require('../migrations/candidates/postgres-food-v1.json'),
  treatments: require('../migrations/candidates/postgres-treatments-socket-order-v1.json'),
  devicestatus: require('../migrations/candidates/postgres-devicestatus-socket-order-v1.json'),
  profile: require('../migrations/candidates/postgres-profile-socket-order-v1.json')
};
// Spike S1b (maintainer 2026-11-20: no production multitenant database; migrations
// may change in place): entries, treatments and devicestatus 0001 now store the
// window time columns, so their prefix hashes were recomputed.
// Test the historical catalogue through the binding correction. Later
// migrations still run in the populated upgrade against the complete catalogue.
function candidate (domain) {
  const catalogue = CANDIDATES[domain];
  const [prefixLength] = PREFIX[domain];
  return { ...catalogue, migrations: catalogue.migrations.slice(0, prefixLength + 2) };
}
const clone = value => JSON.parse(JSON.stringify(value));
const errorCode = code => error => error.code === code;

describe('reviewed tenant-local insertion migration operation', function () {
  for (const domain of builder.DOMAINS) {
    it('preserves exact original migration SQL/checksum prefix and appends only ' + domain + ' conversion', function () {
      const source = candidate(domain), [count, hash] = PREFIX[domain];
      const prefix = source.migrations.slice(0, count);
      assert.equal(crypto.createHash('sha256').update(JSON.stringify(prefix)).digest('hex'), hash);
      assert.equal(source.migrations.length, count + 2);
      const reviewed = validateCatalogue(source), migration = reviewed.at(-2);
      assert.deepEqual(migration.operation, { kind: 'tenant-insertion-v1', domain });
      assert.deepEqual(operationTables(migration), ['tenant_insertion_ordinal', domain]);
      assert.deepEqual(migration.up, builder.build({ namespace: INSERTION_NAMESPACE, domain }).up);
      const sql = renderMigration(migration, 'actual_' + domain);
      assert(sql.every(text => !text.includes(INSERTION_NAMESPACE)));
      assert.deepEqual(sql, builder.build({ namespace: 'actual_' + domain, domain }).up);
      assert(Object.isFrozen(migration.operation) && Object.isFrozen(sql));
    });
  }
  it('appends the binding SQLSTATE correction without changing the conversion plan', function () {
    for (const domain of builder.DOMAINS) {
      const source = candidate(domain);
      assert.equal(crypto.createHash('sha256').update(JSON.stringify(source.migrations.slice(0,-1))).digest('hex'), CONVERSION_PREFIX[domain]);
      const migration = validateCatalogue(source).at(-1);
      assert.deepEqual(migration.operation, { kind: 'tenant-insertion-binding-v1', domain });
      assert.deepEqual(operationTables(migration), []);
      assert.deepEqual(renderMigration(migration, 'actual_'+domain), builder.bindingCorrectionUp({namespace:'actual_'+domain,domain}));
      assert.match(builder.effectiveFunctionBody({namespace:'actual_'+domain,domain}), /BINDING_REQUIRED' USING ERRCODE='42501'/);
      assert.doesNotMatch(builder.build({namespace:INSERTION_NAMESPACE,domain}).up.join('\n'), /BINDING_REQUIRED' USING ERRCODE/);
    }
  });
  it('takes immutable typed metadata and SQL snapshots', function () {
    const source = clone(candidate('entries')), result = validateCatalogue(source), operation = result.at(-2).operation;
    source.migrations.at(-2).operation.domain = 'food'; source.migrations.at(-2).up[0] = 'COMMIT';
    assert.equal(operation.domain, 'entries'); assert(result.at(-2).up[0].startsWith('LOCK TABLE'));
  });
  it('refuses altered typed SQL even with a recomputed catalogue checksum', function () {
    const source = clone(candidate('entries')), migration = source.migrations.at(-2);
    migration.up[1] = 'SET LOCAL row_security = on'; migration.checksum = checksum(migration.up);
    assert.throws(() => validateCatalogue(source), errorCode('MIG_OPERATION_SQL'));
  });
  it('refuses arbitrary operation kinds, domains, extra metadata and untyped controls', function () {
    for (const operation of [{ kind: 'run-sql', domain: 'entries' }, { kind: 'tenant-insertion-v1', domain: 'activity' },
      { kind: 'tenant-insertion-v1', domain: 'entries', namespace: 'untrusted' }, null, []]) {
      const source = clone(candidate('entries')); source.migrations.at(-2).operation = operation;
      assert.throws(() => validateCatalogue(source), errorCode('MIG_OPERATION'));
    }
    const source = clone(candidate('entries')); delete source.migrations.at(-2).operation;
    assert.throws(() => validateCatalogue(source), errorCode('MIG_CATALOGUE'));
  });
  it('refuses unsafe namespaces and preserves ordinary SQL bytes without rendering', function () {
    const migration = validateCatalogue(candidate('entries')).at(-2);
    for (const namespace of ['public', 'pg_temp', 'information_schema', 'x";COMMIT', 'a.b', undefined]) {
      assert.throws(() => renderMigration(migration, namespace), errorCode('MIG_NAMESPACE'));
    }
    const up = ['CREATE TABLE ordinary (n integer)'];
    const plain = { name: '0001_ordinary', up, checksum: checksum(up) };
    assert.deepEqual(renderMigration(plain, 'synthetic'), up);
    assert.deepEqual(operationTables(plain), []);
  });
});
