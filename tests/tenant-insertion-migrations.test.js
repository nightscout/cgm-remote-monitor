'use strict';
// covers: lib/migrations/catalogue.js, lib/migrations/postgres.js
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { checksum, validateCatalogue, renderMigration, operationTables, INSERTION_NAMESPACE } = require('../lib/migrations/catalogue');
const builder = require('../lib/tenant-lifecycle/tenant-insertion-sql');
const PREFIX = {
  entries: [2, '07540566ffe72fcc1856d47cc84b86c7f8911a356f70888e7fd83252dde8536a'],
  food: [1, '6783c5523388b27baee6f1e74174fbb270ce418e852e9fed178b0d8c8315ce38'],
  treatments: [2, '4247649289c4418130b4a7ce9dbb68c77c4edd5765195abd3021487a012383a2'],
  devicestatus: [2, '139bcd14c75841267e8c6c46cb9bed15a563b4e8163b6f4e5d4faa0555193655'],
  profile: [2, '919166cd5fdfa5608e4a178766b1cf2e6f1c101cd24bededc59d02a1d88853d0']
};
const CANDIDATES = {
  entries: require('../migrations/candidates/postgres-entries-v1.json'),
  food: require('../migrations/candidates/postgres-food-v1.json'),
  treatments: require('../migrations/candidates/postgres-treatments-socket-order-v1.json'),
  devicestatus: require('../migrations/candidates/postgres-devicestatus-socket-order-v1.json'),
  profile: require('../migrations/candidates/postgres-profile-socket-order-v1.json')
};
const candidate = domain => CANDIDATES[domain];
const clone = value => JSON.parse(JSON.stringify(value));
const errorCode = code => error => error.code === code;

describe('reviewed tenant-local insertion migration operation', function () {
  for (const domain of builder.DOMAINS) {
    it('preserves exact original migration SQL/checksum prefix and appends only ' + domain + ' conversion', function () {
      const source = candidate(domain), [count, hash] = PREFIX[domain];
      const prefix = source.migrations.slice(0, count);
      assert.equal(crypto.createHash('sha256').update(JSON.stringify(prefix)).digest('hex'), hash);
      assert.equal(source.migrations.length, count + 1);
      const reviewed = validateCatalogue(source), migration = reviewed.at(-1);
      assert.deepEqual(migration.operation, { kind: 'tenant-insertion-v1', domain });
      assert.deepEqual(operationTables(migration), ['tenant_insertion_ordinal', domain]);
      assert.deepEqual(migration.up, builder.build({ namespace: INSERTION_NAMESPACE, domain }).up);
      const sql = renderMigration(migration, 'actual_' + domain);
      assert(sql.every(text => !text.includes(INSERTION_NAMESPACE)));
      assert.deepEqual(sql, builder.build({ namespace: 'actual_' + domain, domain }).up);
      assert(Object.isFrozen(migration.operation) && Object.isFrozen(sql));
    });
  }
  it('takes immutable typed metadata and SQL snapshots', function () {
    const source = clone(candidate('entries')), result = validateCatalogue(source), operation = result.at(-1).operation;
    source.migrations.at(-1).operation.domain = 'food'; source.migrations.at(-1).up[0] = 'COMMIT';
    assert.equal(operation.domain, 'entries'); assert(result.at(-1).up[0].startsWith('LOCK TABLE'));
  });
  it('refuses altered typed SQL even with a recomputed catalogue checksum', function () {
    const source = clone(candidate('entries')), migration = source.migrations.at(-1);
    migration.up[1] = 'SET LOCAL row_security = on'; migration.checksum = checksum(migration.up);
    assert.throws(() => validateCatalogue(source), errorCode('MIG_OPERATION_SQL'));
  });
  it('refuses arbitrary operation kinds, domains, extra metadata and untyped controls', function () {
    for (const operation of [{ kind: 'run-sql', domain: 'entries' }, { kind: 'tenant-insertion-v1', domain: 'activity' },
      { kind: 'tenant-insertion-v1', domain: 'entries', namespace: 'untrusted' }, null, []]) {
      const source = clone(candidate('entries')); source.migrations.at(-1).operation = operation;
      assert.throws(() => validateCatalogue(source), errorCode('MIG_OPERATION'));
    }
    const source = clone(candidate('entries')); delete source.migrations.at(-1).operation;
    assert.throws(() => validateCatalogue(source), errorCode('MIG_CATALOGUE'));
  });
  it('refuses unsafe namespaces and preserves ordinary SQL bytes without rendering', function () {
    const migration = validateCatalogue(candidate('entries')).at(-1);
    for (const namespace of ['public', 'pg_temp', 'information_schema', 'x";COMMIT', 'a.b', undefined]) {
      assert.throws(() => renderMigration(migration, namespace), errorCode('MIG_NAMESPACE'));
    }
    const up = ['CREATE TABLE ordinary (n integer)'];
    const plain = { name: '0001_ordinary', up, checksum: checksum(up) };
    assert.deepEqual(renderMigration(plain, 'synthetic'), up);
    assert.deepEqual(operationTables(plain), []);
  });
});
