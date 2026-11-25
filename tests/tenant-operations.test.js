'use strict';
// covers: lib/tenant-operations/upgrade.js, lib/tenant-operations/common.js

const assert = require('node:assert/strict');
const { validateCatalogue } = require('../lib/migrations/catalogue');
const common = require('../lib/tenant-operations/common');
const operations = require('../lib/tenant-operations');
const { legacyInsertionCatalogue } = require('./fixtures/legacy-insertion-catalogue');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const HEX = '0123456789abcdef01234567';

const CANDIDATES = {
  entries: legacyInsertionCatalogue(require('../migrations/candidates/postgres-entries-v1.json')),
  clock: require('../migrations/candidates/postgres-write-clock-v1.json'),
  access: require('../lib/tenant-authorization/access-candidate.json'),
  secrets: require('../lib/secrets/postgres-candidate.json')
};
const TABLES = {
  entries: ['entries'],
  clock: ['tenant_write_clock'],
  access: ['access_tenants', 'access_credentials', 'access_sessions', 'access_keys', 'management_session_requests'],
  secrets: ['secret_records', 'secret_audit']
};
const NS = { entries: 'ns_entries', clock: 'ns_clock', access: 'ns_access', secrets: 'ns_secrets' };

function catalogues (namespaces = NS, overrides = {}) {
  return Object.keys(TABLES).map(kind => ({
    kind, namespace: namespaces[kind], catalogue: overrides[kind] || CANDIDATES[kind], tables: TABLES[kind], secrets: kind === 'secrets' ? ['secret_records'] : []
  }));
}

describe('deployment catalogue plan', function () {
  it('validates the injected catalogue list and refuses a shared namespace', function () {
    const steps = operations.plan(catalogues());
    assert.deepEqual(steps.map(s => s.kind), ['entries', 'clock', 'access', 'secrets']);
    assert.match(steps[0].catalogueChecksum, /^[a-f0-9]{64}$/);
    assert.throws(() => operations.plan(catalogues({ ...NS, clock: NS.entries })), { code: 'OPERATIONS_NAMESPACE_SHARED' });
    assert.throws(() => operations.plan(catalogues({ ...NS, clock: 'public' })), { code: 'OPERATIONS_NAMESPACE_INVALID' });
    assert.throws(() => operations.plan([]), { code: 'OPERATIONS_CATALOGUES_REQUIRED' });
    assert.throws(() => operations.plan(catalogues(NS, { entries: { version: 1, migrations: [] } })), { code: 'MIG_CATALOGUE' });
  });
});

describe('tenant operations current native fixture contract (recording only)', function () {
  const current = require('./fixtures/tenant-operations-current');
  const restore = require('../tools/lab/tenant-whole-c/fixture-acl');
  const ns = { entries: 'fixture_entries', clock: 'fixture_clock' };

  it('admits parent-first counter inventory while retaining the exact old source for upgrade', async function () {
    const input = current.upgradePlan(ns);
    const target = common.plan(input.catalogues);
    assert.deepEqual(target[0].tables, ['tenant_insertion_ordinal', 'entries']);
    assert.deepEqual(common.plan(input.sourceCatalogues)[0].tables, ['entries']);
    const stale = input.catalogues.map(entry => entry.kind === 'entries' ? { ...entry, tables: ['entries'] } : entry);
    assert.throws(() => common.plan(stale), { code: 'LIFECYCLE_COUNTER_INVENTORY_INCOMPLETE' });
  });

  it('binds every actual native seed insert transaction-locally and rolls back interrupted setup', async function () {
    function recording (interrupt = false) {
      let binding = null, active = false, rows = [], staged;
      const log = [];
      return { log, rows: () => rows, binding: () => binding, query: async (sql, values = []) => {
        log.push({ sql, values });
        if (sql === 'BEGIN') { assert(!active); active = true; staged = []; }
        else if (sql.includes("set_config('app.current_tenant_id'")) { assert(active); assert(sql.endsWith(',$1,true)')); binding = values[0]; }
        else if (sql.startsWith('INSERT INTO')) {
          if (binding !== values[0]) throw Object.assign(new Error('TENANT_ORDINAL_BINDING_REQUIRED'), { code: '42501' });
          assert(active); if (interrupt && staged.length) throw new Error('synthetic seed interruption');
          staged.push({ tenant: values[0], kind: values[1], doc: JSON.parse(values[2]) });
        } else if (sql === 'COMMIT') { rows = staged; active = false; binding = null; }
        else if (sql === 'ROLLBACK') { staged = []; active = false; binding = null; }
        else assert.fail('Unexpected fixture SQL');
        return { rows: [], rowCount: 1 };
      } };
    }
    const rows = [{ tenant: A, kind: 'objectid', doc: { _id: HEX, sgv: 100 } },
      { tenant: B, kind: 'string', doc: { _id: HEX, sgv: 200 } }];
    const ok = recording(); await current.seedEntries(ok, ns.entries, rows);
    assert.deepEqual(ok.rows(), rows); assert.equal(ok.binding(), null);
    assert.equal(ok.log.filter(entry => entry.sql.startsWith('INSERT')).length, 2);
    const broken = recording(true);
    await assert.rejects(current.seedEntries(broken, ns.entries, rows), /synthetic seed interruption/);
    assert.deepEqual(broken.rows(), []); assert.equal(broken.binding(), null); assert.equal(broken.log.at(-1).sql, 'ROLLBACK');
  });

  it('uses explicit serving ACL declarations and observes raw ordinals and floors independently', async function () {
    const steps = common.plan(current.catalogues(ns));
    restore.validateAcl(current.applicationAcl('fixture_app'), steps);
    assert.throws(() => restore.validateAcl({ role: 'fixture_app' }, steps), { code: 'RESTORE_TENANT_COUNTER_EXPLICIT_ACL_REQUIRED' });
    const invalidAcl = current.applicationAcl('fixture_app'); invalidAcl.grants[0].role = 'bad-role';
    assert.throws(() => restore.validateAcl(invalidAcl, steps), { code: 'RESTORE_ACL_ROLE_INVALID' });
    const state = { rows: [{ tenant_id: A, id_kind: 'objectid', doc: { _id: HEX } }], stamps: [{ tenant_id: A, last_stamp: '9223372036854775806' }],
      counters: [{ tenant_id: A, last_ordinal: '9007199254740993' }], ordinals: [{ tenant_id: A, id_kind: 'objectid', doc: { _id: HEX }, insertion_ordinal: '9007199254740993' }] };
    const log = [];
    const connection = { query: async sql => {
      log.push(sql);
      return { rows: sql.includes('last_ordinal') ? state.counters : sql.includes('insertion_ordinal') ? state.ordinals : sql.includes('last_stamp') ? state.stamps : state.rows };
    } };
    assert.deepEqual(await current.observe(connection, ns), state);
    assert.equal(log.length, 4); assert(log.every(sql => sql.startsWith('SELECT')));
    assert.deepEqual(await current.observe(connection, ns, true), { ...state, counters: [], ordinals: [] });
  });
});
