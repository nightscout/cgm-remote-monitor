'use strict';
// covers: lib/tenant-lifecycle/tenant-insertion-sql.js
const assert = require('node:assert/strict');
const source = require('../lib/tenant-lifecycle/tenant-insertion-sql');
const { validateCatalogue, checksum } = require('../lib/migrations/catalogue');

describe('standalone tenant insertion conversion SQL proposal', function () {
  it('accepts only the five fixed source domains and non-system namespaces', function () {
    assert.deepEqual(source.DOMAINS, ['entries', 'food', 'treatments', 'devicestatus', 'profile']);
    for (const domain of source.DOMAINS) {
      const value = source.build({ namespace: 'synthetic_' + domain, domain });
      assert.equal(value.domain, domain); assert(Object.isFrozen(value) && Object.isFrozen(value.up));
    }
    for (const namespace of ['public', 'pg_catalog', 'information_schema', 'one.two', 'x";DROP TABLE x', '', undefined]) {
      assert.throws(() => source.build({ namespace, domain: 'entries' }), /identifier/);
    }
    for (const domain of ['activity', 'settings', 'unknown', undefined]) assert.throws(() => source.build({ namespace: 'synthetic', domain }), /domain/);
  });
  it('refuses unsafe role interpolation and returns separate ordinary/restore column grants', function () {
    const value = source.build({ namespace: 'synthetic', domain: 'profile' });
    for (const role of ['PUBLIC', 'pg_owner', 'x";GRANT ALL', undefined]) assert.throws(() => value.servingGrants(role), /identifier/);
    const ordinary = value.servingGrants('synthetic_app'), restore = value.restoreGrants('synthetic_operator');
    assert(ordinary.some(sql => sql.includes('REVOKE INSERT (insertion_ordinal)')));
    assert(ordinary.some(sql => sql.includes('GRANT INSERT (tenant_id,id_kind,doc)')));
    assert(!ordinary.some(sql => sql.includes('GRANT INSERT (tenant_id,id_kind,doc,insertion_ordinal)')));
    assert(restore.some(sql => sql.includes('GRANT INSERT (tenant_id,id_kind,doc,insertion_ordinal)')));
    assert(ordinary.some(sql => sql.includes('UPDATE (last_ordinal)')));
    assert(Object.isFrozen(ordinary));
  });
  it('provides explicit effective ACL validation including inherited/public ordinal grants', function () {
    const value = source.build({ namespace: 'synthetic', domain: 'profile' });
    const serving = value.verifyGrants('synthetic_app');
    const restore = value.verifyGrants('synthetic_operator', { restore: true });
    assert(serving.includes("'insertion_ordinal','INSERT') IS DISTINCT FROM false"));
    assert(restore.includes("'insertion_ordinal','INSERT') IS DISTINCT FROM true"));
    assert(serving.includes("'tenant_id','UPDATE')"));
    assert(serving.includes('DELETE,TRUNCATE,REFERENCES,TRIGGER'));
    assert.throws(() => value.verifyGrants('x;GRANT ALL'), /identifier/);
    assert.throws(() => value.verifyGrants('synthetic_app', { restore: 'yes' }), /selection/);
  });
  it('keeps untyped control SQL rejected by the migration catalogue grammar', function () {
    const { up } = source.build({ namespace: 'synthetic', domain: 'entries' });
    assert.throws(() => validateCatalogue({ version: 1, migrations: [{ name: '0003_tenant_local_insertion', up, checksum: checksum(up) }] }), error => error.code === 'MIG_CATALOGUE');
    assert(up[0].startsWith('LOCK TABLE')); assert(up[1].startsWith('SET LOCAL')); assert(up[2].startsWith('DO '));
  });
});
