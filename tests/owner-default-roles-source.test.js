'use strict';
const assert = require('node:assert/strict');
const provision = require('../lib/subject-admin/provision-default-roles');
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
describe('operator default-role preparation source', function () {
  it('provisions shipping wildcard roles per tenant and refuses an existing changed default', async function () {
    const stored = new Map([[B + '/admin', ['foreign:read']]]);
    const connection = { async query (sql, values) {
      if (sql.startsWith('SELECT current_setting')) return { rows: [{ tenant: A }] };
      const key = values[0] + '/' + values[1];
      if (sql.startsWith('INSERT')) { if (!stored.has(key)) stored.set(key, structuredClone(values[2])); return { rows: [] }; }
      if (sql.startsWith('SELECT permissions')) return { rows: stored.has(key) ? [{ permissions: structuredClone(stored.get(key)) }] : [] };
      throw new Error('unexpected SQL');
    } };
    await provision(connection, { tenant: A, namespace: 'auth' });
    assert.deepEqual(stored.get(A + '/admin'), ['*']); assert.deepEqual(stored.get(A + '/readable'), ['*:*:read']);
    assert.deepEqual(stored.get(A + '/devicestatus-upload'), ['api:devicestatus:create']);
    assert.deepEqual(stored.get(B + '/admin'), ['foreign:read']);
    const original = structuredClone([...stored]); await provision(connection, { tenant: A, namespace: 'auth' });
    assert.deepEqual([...stored], original);
    stored.set(A + '/admin', ['custom:permission']);
    await assert.rejects(provision(connection, { tenant: A, namespace: 'auth' }), { code: 'SUBJECT_ADMIN_DEFAULT_ROLE_CONFLICT' });
    assert.deepEqual(stored.get(A + '/admin'), ['custom:permission']);
    await assert.rejects(provision(connection, { tenant: B, namespace: 'auth' }), /transaction mismatch/);
  });
});
