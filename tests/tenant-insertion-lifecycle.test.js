'use strict';
// covers: lib/tenant-lifecycle/insertion-inventory.js, lib/tenant-lifecycle/index.js, lib/tenant-operations/catalogues.js, lib/tenant-operations/common.js, lib/tenant-operations/restore.js
const assert = require('node:assert/strict');
const insertion = require('../lib/tenant-lifecycle/insertion-inventory');
const lifecycle = require('../lib/tenant-lifecycle');
const artifacts = require('../lib/tenant-lifecycle/artifact');
const common = require('../lib/tenant-operations/common');
const restore = require('../lib/tenant-operations/restore');
const { createdTables } = require('../lib/tenant-operations/catalogues');
const candidate = require('../migrations/candidates/postgres-entries-v1.json');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const counter = insertion.COUNTER;
const selected = () => ({ kind: 'entries', namespace: 'owned_entries', catalogue: candidate, tables: [counter, 'entries'] });
function artifact () {
  return artifacts.buildArtifact({ tenant: A, sourceCommit: 'f'.repeat(40), exportedAt: 1700000000000,
    catalogues: [{ kind: 'entries', namespace: 'owned_entries', ledger: candidate.migrations,
      tables: [
        { table: counter, columns: [{ name: 'tenant_id', type: 'uuid' }, { name: 'last_ordinal', type: 'bigint' }], rows: [{ tenant_id: A, last_ordinal: '17' }] },
        { table: 'entries', columns: [{ name: 'tenant_id', type: 'uuid' }, { name: 'id_kind', type: 'text' }, { name: 'doc', type: 'jsonb' }, { name: 'insertion_ordinal', type: 'bigint' }], rows: [{ tenant_id: A, id_kind: 'string', doc: { _id: 'synthetic' }, insertion_ordinal: '7' }] }
      ] }] });
}

describe('tenant-local insertion lifecycle inventory and refusal', function () {
  it('captures/imports counter before clinical rows and deletes in reverse', function () {
    const entry = lifecycle.admittedCatalogue().find(item => item.kind === 'entries');
    assert.deepEqual(entry.tables, [counter, 'entries']);
    assert.deepEqual([...entry.tables].reverse(), ['entries', counter]);
    assert.deepEqual(createdTables(candidate), entry.tables);
    assert.deepEqual(common.plan([selected()])[0].tables, entry.tables);
    assert.throws(() => common.plan([{ ...selected(), tables: ['entries'] }]), { code: 'LIFECYCLE_COUNTER_INVENTORY_INCOMPLETE' });
    assert.throws(() => lifecycle.createLifecycle({ catalogues: [{ kind: 'entries', candidate, tables: ['entries'] }] }), { code: 'LIFECYCLE_COUNTER_INVENTORY_INCOMPLETE' });
  });

  it('recognizes only the audited typed operation and retains old non-ordinal domains', function () {
    const legacy = { ...candidate, migrations: candidate.migrations.filter(item => !item.operation) };
    assert.equal(insertion.hasCounter(legacy, 'entries'), false);
    assert.deepEqual(createdTables(legacy), ['entries']);
    assert.deepEqual(insertion.tableOrder('profile', require('../migrations/candidates/postgres-profile-v1.json'), ['profile']), ['profile']);
    for (const [domain, ordered] of [
      ['treatments', require('../migrations/candidates/postgres-treatments-socket-order-v1.json')],
      ['devicestatus', require('../migrations/candidates/postgres-devicestatus-socket-order-v1.json')],
      ['profile', require('../migrations/candidates/postgres-profile-socket-order-v1.json')]
    ]) {
      assert.deepEqual(createdTables(ordered), [counter, domain]);
    }
  });

  it('preserves the saved counter beyond surviving maximum and refuses missing/corrupt floors', function () {
    const original = artifact();
    assert.deepEqual(insertion.assertArtifact(original, 'entries'), { floor: '17', rows: 1 });
    assert.equal(original.tables['entries.' + counter][0].last_ordinal, '17');
    const missing = structuredClone(original); missing.tables['entries.' + counter] = [];
    assert.throws(() => insertion.assertArtifact(missing, 'entries'), { code: 'LIFECYCLE_COUNTER_ARTIFACT_INCOMPLETE' });
    const low = structuredClone(original); low.tables['entries.' + counter][0].last_ordinal = '6';
    assert.throws(() => insertion.assertArtifact(low, 'entries'), { code: 'LIFECYCLE_COUNTER_ARTIFACT_INVALID' });
    assert.deepEqual(insertion.assertArtifact(original, 'entries'), { floor: '17', rows: 1 }, 'fresh original remains valid');
  });

  it('checks deployment floors independently per tenant, allowing equal ordinals across tenants', function () {
    const counters = [{ tenant_id: A, last_ordinal: '7' }, { tenant_id: B, last_ordinal: '7' }];
    const rows = [{ tenant_id: A, insertion_ordinal: '7' }, { tenant_id: B, insertion_ordinal: '7' }];
    insertion.assertState(counters, rows, 'entries');
    assert.throws(() => insertion.assertState(counters, [...rows, rows[0]], 'entries'), { code: 'LIFECYCLE_COUNTER_ARTIFACT_INVALID' });
    assert.throws(() => insertion.assertState(counters.slice(0, 1), rows, 'entries'), { code: 'LIFECYCLE_COUNTER_ARTIFACT_INVALID' });
  });

  it('refuses new-schema import without real maintenance before entering any transaction', async function () {
    const selectedLifecycle = lifecycle.createLifecycle({ catalogues: [{ kind: 'entries', candidate, tables: [counter, 'entries'] }] });
    const connection = { transaction: () => assert.fail('no maintenance: no SQL body may start') };
    await assert.rejects(selectedLifecycle.importArtifact(connection, artifact(), { tenant: A, namespaces: { entries: 'owned_entries' } }), { code: 'LIFECYCLE_MAINTENANCE_REQUIRED' });
  });

  it('requires actual held maintenance for clock-bearing logical reconciliation', async function () {
    const clock = require('../migrations/candidates/postgres-write-clock-v1.json');
    const selectedLifecycle = lifecycle.createLifecycle({ catalogues: [
      { kind: 'entries', candidate, tables: [counter, 'entries'] },
      { kind: 'clock', candidate: clock, tables: ['tenant_write_clock'] }
    ] });
    const original = artifact();
    const catalogues = original.manifest.catalogues.map(entry => ({ ...entry, tables: entry.tables.map(table => ({
      ...table, rows: original.tables[entry.kind + '.' + table.table]
    })) }));
    catalogues.push({ kind: 'clock', namespace: 'owned_clock', ledger: clock.migrations, tables: [{
      table: 'tenant_write_clock', columns: [{ name: 'tenant_id', type: 'uuid' }, { name: 'last_stamp', type: 'bigint' }],
      rows: [{ tenant_id: A, last_stamp: '1000' }]
    }] });
    const snapshot = artifacts.buildArtifact({ tenant: A, sourceCommit: 'f'.repeat(40), exportedAt: 1700000000000, catalogues });
    const connection = { transaction: fn => fn(), query: () => assert.fail('forged claim must refuse before SQL') };
    const scope = require('../lib/storage/tenant-scope'), previous = scope.getTenancyMode(); scope.setTenancyMode('multi');
    try { await assert.rejects(selectedLifecycle.importArtifact(connection, snapshot, { tenant: A,
      namespaces: { entries: 'owned_entries', clock: 'owned_clock' }, maintenanceClaim: Object.freeze({})
    }), { code: 'LIFECYCLE_RESTORE_CLAIM_INVALID' }); } finally { scope.setTenancyMode(previous); }
  });

  it('requires a typed narrow ACL instead of blanket INSERT on new counter schemas', function () {
    const steps = common.plan([selected()]);
    assert.throws(() => restore.validateAcl({ role: 'ordinary' }, steps), { code: 'RESTORE_TENANT_COUNTER_EXPLICIT_ACL_REQUIRED' });
    const declaration = { kind: 'entries', role: 'ordinary', mode: 'serving' };
    const grant = { kind: 'entries', role: 'ordinary', table: 'entries', privileges: ['SELECT'] };
    restore.validateAcl({ grants: [grant], tenantInsertion: [declaration] }, steps);
    assert.throws(() => restore.validateAcl({ grants: [{ ...grant, privileges: ['SELECT', 'INSERT'] }], tenantInsertion: [declaration] }, steps), { code: 'RESTORE_TENANT_COUNTER_BROAD_GRANT' });
    assert.throws(() => restore.validateAcl({ grants: [grant] }, steps), { code: 'RESTORE_TENANT_COUNTER_ACL_REQUIRED' });
  });

  it('emits reader-only grants without mutation/EXECUTE and records effective target-role checks', async function () {
    const steps = common.plan([selected()]);
    const acl = { grants: [], tenantInsertion: [{ kind: 'entries', role: 'reader', mode: 'reader' }] };
    restore.validateAcl(acl, steps);
    const prepared = await restore.prepareAcl({ query: () => assert.fail('no sequence or schema discovery is needed') }, steps, [], acl);
    assert(prepared.statements.every(sql => /^GRANT (USAGE ON SCHEMA|SELECT ON)/.test(sql)));
    assert(!prepared.statements.some(sql => /INSERT|UPDATE|EXECUTE|DELETE/.test(sql)));
    assert.deepEqual(prepared.roleChecks, [{ namespace: 'owned_entries', domain: 'entries', role: 'reader', mode: 'reader' }]);
  });

  it('admits counter DELETE only for the declared private restore role and verifies its effective role', async function () {
    const steps = common.plan([selected()]);
    const declaration = { kind: 'entries', role: 'restorer', mode: 'restore' };
    const acl = { grants: [{ kind: 'entries', table: counter, role: 'restorer', privileges: ['SELECT', 'DELETE'] }], tenantInsertion: [declaration] };
    restore.validateAcl(acl, steps);
    const prepared = await restore.prepareAcl({}, steps, [], acl);
    assert(prepared.statements.includes('GRANT DELETE ON "owned_entries"."tenant_insertion_ordinal" TO "restorer"'));
    assert.deepEqual(prepared.roleChecks, [{ namespace: 'owned_entries', domain: 'entries', role: 'restorer', mode: 'restore' }]);
    assert(!prepared.statements.some(sql => sql.includes('$tenant_insertion_acl$')), 'shared current restore-role oracle replaces the older narrower verifier');
    assert.throws(() => restore.validateAcl({ ...acl, tenantInsertion: [{ ...declaration, mode: 'serving' }] }, steps), { code: 'RESTORE_TENANT_COUNTER_BROAD_GRANT' });
  });

  it('captures full SQL timestamp precision before the driver Date conversion', async function () {
    const expected = [{ tenant_id: A, owner_birth: '2026-11-07T00:00:00.123456Z' }];
    let sql;
    const actual = await common.readRows({ query: async text => { sql = text; return { rows: expected }; } }, 'owned_control', 'tenant_lifecycle_operations', [
      { name: 'tenant_id', type: 'uuid' }, { name: 'owner_birth', type: 'timestamp with time zone' }
    ]);
    assert(sql.includes('AT TIME ZONE \'UTC\''));
    assert(sql.includes('HH24:MI:SS.US"Z"'));
    assert.deepEqual(actual, expected);
    assert(common.encodeTable(actual).text.includes('.123456Z'));
  });
});
