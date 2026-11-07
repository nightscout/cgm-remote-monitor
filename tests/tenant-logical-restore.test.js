'use strict';
// Protocol/source tests. Actual PG roles, held claims and processes are native gates.
// covers: lib/tenant-lifecycle/logical-restore.js, lib/tenant-lifecycle/index.js
const assert = require('node:assert/strict');
const logical = require('../lib/tenant-lifecycle/logical-restore');
const lifecycle = require('../lib/tenant-lifecycle');
const scope = require('../lib/storage/tenant-scope');
const { fixture, withAdmission, A, B, BASE, clone } = require('./fixtures/logical-restore-protocol');
const security = require('../lib/api3/security');
const history = require('../lib/api3/generic/history/operation');
const utils = require('../lib/api3/storage/mongoCollection/utils');
const args = f => ({ tenant: A, namespaces: f.namespaces, maintenanceClaim: f.token, catalogues: f.catalogues });
describe('tenant logical restore forward history', function () {
  let tenancy, now;
  beforeEach(function () { tenancy = scope.getTenancyMode(); scope.setTenancyMode('multi'); now = Date.now; Date.now = () => BASE + 9000; });
  afterEach(function () { scope.setTenancyMode(tenancy); Date.now = now; });

  it('reconciles changed/missing/current-only IDs, preserves unchanged metadata and current authority', async function () {
    const f = fixture(), before = clone(f.durable), notifications = []; f.begin();
    const result = await withAdmission(f, () => logical.restore(f.connection, f.artifact, { ...args(f), onCommitted: value => notifications.push(value) }));
    assert.equal(notifications.length, 0, 'no notification before actual outer commit');
    assert.equal(f.durable.clock[A], before.clock[A], 'outer transaction remains uncommitted');
    await f.commit(); assert.equal(notifications.length, 1);
    const entries = f.durable.tables.entries.filter(row => row.tenant_id === A);
    assert.deepEqual(entries.map(row => row.doc._id), ['stable', 'changed', 'missing', 'postbackup']);
    assert.deepEqual(entries[0].doc, before.tables.entries[0].doc, 'unchanged public document retains all live metadata');
    assert.equal(entries[1].doc.value, 'old'); assert.equal(entries[1].doc.srvCreated, before.tables.entries[1].doc.srvCreated);
    assert.equal(entries[2].doc.srvCreated, entries[2].doc.srvModified, 'missing record uses normal new-record metadata');
    assert.equal(entries[3].doc.isValid, false); assert(entries.slice(1).every(row => row.doc.srvModified > Number(before.clock[A])));
    assert.deepEqual(f.durable.authority, before.authority); assert.equal(f.durable.clock[B], before.clock[B]);
    assert.deepEqual(f.durable.tables.entries.filter(row => row.tenant_id === B), before.tables.entries.filter(row => row.tenant_id === B));
    assert.equal(f.durable.counter.entries[B], before.counter.entries[B]); assert(BigInt(f.durable.counter.entries[A]) > BigInt(before.counter.entries[A]));
    assert.equal(result.historyScope, 'current-live-and-artifact-identities'); assert(result.preservedKinds.includes('access')); assert(f.admissionCalls >= 2);
  });

  it('actual history handler produces changes/deletion consumed by a synthetic incremental cache', async function () {
    const f = fixture(), cursor = Number(f.durable.clock[A]);
    const cache = new Map(f.durable.tables.entries.filter(row => row.tenant_id === A).map(row => [row.doc.identifier, clone(row.doc)]));
    f.begin(); await withAdmission(f, () => logical.restore(f.connection, f.artifact, args(f))); await f.commit();
    const authenticate = security.authenticate, permission = security.demandPermission; let response, filter;
    try {
      security.authenticate = async () => ({ synthetic: true }); security.demandPermission = async () => true;
      const col = { colName: 'entries', parseLimit: () => 100, storage: { findMany: async options => {
        filter = options.filter; return f.durable.tables.entries.filter(row => row.tenant_id === A && row.doc.srvModified > options.filter[0].value)
          .sort((a, b) => a.doc.srvModified - b.doc.srvModified).map(row => { const doc = clone(row.doc); utils.normalizeDoc(doc); return doc; });
      } } };
      const req = { params: { lastModified: new Date(cursor).toISOString() }, query: { fields: '_all' } };
      const res = { headersSent: false, status (n) { assert.equal(n, 200); return this; }, setHeader () {}, format (types) { types.json(); }, send (body) { response = body; }, json (body) { response = body; } };
      await history({}, { apiV3DataWarnings: false }, {}, col)(req, res);
    } finally { security.authenticate = authenticate; security.demandPermission = permission; }
    assert.deepEqual(filter, [{ field: 'srvModified', operator: 'gt', value: cursor }]);
    for (const doc of response.result) { if (doc.isValid === false) cache.delete(doc.identifier); else cache.set(doc.identifier, doc); }
    assert.deepEqual([...cache.keys()].sort(), ['changed', 'missing', 'stable']); assert.equal(cache.get('changed').value, 'old');
    assert(response.result.some(doc => doc.identifier === 'postbackup' && doc.isValid === false));
  });

  it('rolls back all A history/counter changes, suppresses notifications and retains independently committed B', async function () {
    const f = fixture(), before = clone(f.durable); let notifications = 0; f.begin();
    await assert.rejects(withAdmission(f, () => logical.restore(f.connection, f.artifact, { ...args(f), onRow: () => { f.appendB(); throw new Error('INTERRUPTED'); }, onCommitted: () => notifications++ })), /INTERRUPTED/);
    f.rollback(); assert.equal(notifications, 0); assert.equal(f.durable.clock[A], before.clock[A]); assert.equal(f.durable.counter.entries[A], before.counter.entries[A]);
    assert.deepEqual(f.durable.tables.entries.filter(row => row.tenant_id === A), before.tables.entries.filter(row => row.tenant_id === A));
    assert.deepEqual(f.durable.tables.entries.filter(row => row.tenant_id === B).slice(0, -1), before.tables.entries.filter(row => row.tenant_id === B));
    assert.equal(f.durable.tables.entries.at(-1).doc._id, 'B-during');
  });

  it('keeps artifact relative profile arrival order and physically removes legacy activity without tombstones', async function () {
    const f = fixture(); f.begin(); await withAdmission(f, () => logical.restore(f.connection, f.artifact, args(f))); await f.commit();
    const port = require('../lib/server/tenant-app/profile')({ connection: f.connection, table: 'logical_profile.profile', source: 'socket', naturalOrder: true });
    const selected = await scope.withTenant(A, () => require('../lib/server/storage-reads').findOne(port.storage, { NSCLIENT_ID: 'synthetic' }));
    assert.equal(selected._id, 'z-first'); assert.equal(selected.store.Synthetic.dia, 3);
    const activityPort = require('../lib/server/tenant-app/activity')({ connection: f.connection, table: 'logical_activity.activity' });
    const activity = require('../lib/server/activity')({}, { storagePorts: { resolve: () => activityPort } });
    const visible = await scope.withTenant(A, () => activity.list({ count: 10 }));
    assert.deepEqual(visible.map(doc => doc._id), ['activity-old']); assert.equal(visible[0].value, 'old');
    assert(!visible.some(doc => doc.isValid === false || doc.srvModified !== undefined));
  });

  it('allows independent B progress during success and retains it after precommit claim loss rollback', async function () {
    for (const loseClaim of [false, true]) {
      const f = fixture(), before = clone(f.durable); f.failPrecommit = loseClaim; let appended = false, effects = 0; f.begin();
      const run = () => withAdmission(f, () => logical.restore(f.connection, f.artifact, { ...args(f),
        onRow: () => { if (!appended) { f.appendB(); appended = true; } }, onCommitted: () => effects++ }));
      if (loseClaim) { await assert.rejects(run(), { code: 'LIFECYCLE_RESTORE_CLAIM_LOST' }); f.rollback(); }
      else { await run(); assert.equal(effects, 0); await f.commit(); }
      assert.equal(effects, loseClaim ? 0 : 1);
      assert.deepEqual(f.durable.tables.entries.filter(row => row.tenant_id === B).slice(0, -1), before.tables.entries.filter(row => row.tenant_id === B));
      assert.equal(f.durable.tables.entries.filter(row => row.tenant_id === B).at(-1).doc._id, 'B-during');
      assert.equal(BigInt(f.durable.counter.entries[B]), BigInt(before.counter.entries[B]) + 1n);
      if (loseClaim) assert.deepEqual(f.durable.tables.entries.filter(row => row.tenant_id === A), before.tables.entries.filter(row => row.tenant_id === A));
    }
  });

  it('refuses missing/behind live floor and forged maintenance before clinical effects', async function () {
    for (const change of [f => { delete f.durable.clock[A]; }, f => { f.durable.clock[A] = '1'; }]) {
      const f = fixture(); change(f); f.begin();
      await assert.rejects(withAdmission(f, () => logical.restore(f.connection, f.artifact, args(f))), e => ['LIFECYCLE_LOGICAL_LIVE_FLOOR_REQUIRED', 'LIFECYCLE_LOGICAL_LIVE_FLOOR_BEHIND', 'LIFECYCLE_LOGICAL_ARTIFACT_FLOOR_AHEAD'].includes(e.code));
      assert(!f.trace.some(item => item.sql.startsWith('DELETE'))); f.rollback();
    }
    const f = fixture(); f.begin(); await assert.rejects(logical.restore(f.connection, f.artifact, args(f)), { code: 'LIFECYCLE_RESTORE_CLAIM_INVALID' }); assert.equal(f.trace.length, 0); f.rollback();
  });

  it('refuses ambiguous public identifiers and unavailable artifact ordering rather than picking a twin', function () {
    const f = fixture(), desired = clone(f.desired.entries);
    desired[0].insertion_ordinal = undefined;
    assert.throws(() => logical.planRows({ kind: 'entries', current: f.durable.tables.entries.filter(row => row.tenant_id === A), desired, ordered: true }), { code: 'LIFECYCLE_LOGICAL_ORDER_UNAVAILABLE' });
    const twin = clone(f.desired.entries[0]); twin.id_kind = 'objectid'; twin.doc._id = '0123456789abcdef01234567';
    assert.throws(() => logical.planRows({ kind: 'entries', current: [], desired: [...f.desired.entries, twin], ordered: true }), { code: 'LIFECYCLE_LOGICAL_IDENTITY_AMBIGUOUS' });
  });

  it('refuses known captured clocks or modification metadata ahead of the live floor before effects', async function () {
    const artifacts = require('../lib/tenant-lifecycle/artifact');
    const cases = [
      { change: tables => { tables['clock.tenant_write_clock'][0].last_stamp = String(BASE + 50000); }, code: 'LIFECYCLE_LOGICAL_ARTIFACT_FLOOR_AHEAD' },
      { change: tables => { tables['clock.tenant_write_clock'][0].last_stamp = 'malformed'; }, code: 'LIFECYCLE_LOGICAL_ARTIFACT_FLOOR_INVALID' },
      { change: tables => { tables['clock.tenant_write_clock'] = []; }, code: 'LIFECYCLE_LOGICAL_ARTIFACT_FLOOR_INVALID' },
      { change: tables => { tables['entries.entries'].find(row => row.doc._id === 'changed').doc.srvModified = BASE + 50000; }, code: 'LIFECYCLE_LOGICAL_ARTIFACT_METADATA_AHEAD' },
      { change: tables => { tables['entries.entries'][0].doc.srvModified = 'malformed'; }, code: 'LIFECYCLE_LOGICAL_HISTORY_INVALID' }
    ];
    for (const { change, code } of cases) {
      const f = fixture(), before = clone(f.durable), tables = clone(f.artifact.tables); let effects = 0; change(tables);
      f.artifact = artifacts.buildArtifact({ tenant: A, sourceCommit: 'f'.repeat(40), exportedAt: BASE + 60000,
        catalogues: f.artifact.manifest.catalogues.map(c => ({ ...c, tables: c.tables.map(t => ({ ...t, rows: tables[c.kind + '.' + t.table] })) })) });
      f.begin();
      await assert.rejects(withAdmission(f, () => logical.restore(f.connection, f.artifact, { ...args(f), onCommitted: () => effects++ })), { code });
      assert(!f.trace.some(item => /^(DELETE|INSERT|UPDATE)/.test(item.sql)), 'input refusal before row/counter/clock effects');
      assert.deepEqual(f.working, before, 'all A/B rows, authority, clocks and counters unchanged');
      f.rollback(); assert.deepEqual(f.durable, before); assert.equal(effects, 0);
    }
    const fresh = fixture(); fresh.begin(); await withAdmission(fresh, () => logical.restore(fresh.connection, fresh.artifact, args(fresh))); await fresh.commit();
    assert.equal(fresh.durable.tables.entries.find(row => row.doc._id === 'changed').doc.value, 'old');
  });

  it('default clock-bearing import selects logical reconciliation instead of stale raw metadata replay', async function () {
    const f = fixture(); f.begin(); const selected = lifecycle.createLifecycle({ catalogues: f.catalogues });
    const result = await withAdmission(f, () => selected.importArtifact(f.connection, f.artifact, { tenant: A, namespaces: f.namespaces, maintenanceClaim: f.token }));
    assert.equal(result.mode, 'logical-history-reconciliation'); await f.commit(); assert(Number(f.durable.clock[A]) > 1000);
  });
});
